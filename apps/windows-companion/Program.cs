using System.Net;
using System.Reflection;
using System.Text.Json;
using SheetAgent.Companion;

internal static class Program
{
    [STAThread]
    private static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = AppContext.BaseDirectory,
            WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
        });
        ConfigureLocalEndpoint(builder);
        builder.Services.AddSingleton<ICredentialStore, DpapiCredentialStore>();
        builder.Services.AddSingleton<PairingService>();
        builder.Services.AddSingleton<StartupManager>();
        builder.Services.AddSingleton(new HttpClient { Timeout = TimeSpan.FromSeconds(60) });
        builder.Services.AddSingleton<ProviderClient>();
        var app = builder.Build();
        MapApi(app);
        await app.StartAsync();
        System.Windows.Forms.Application.EnableVisualStyles();
        System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
        System.Windows.Forms.Application.Run(new TrayApplicationContext(app.Services.GetRequiredService<PairingService>(), app.Services.GetRequiredService<ICredentialStore>(), app.Services.GetRequiredService<StartupManager>()));
        await app.StopAsync();
    }

    internal const int DefaultPort = 47831;

    internal static void ConfigureLocalEndpoint(WebApplicationBuilder builder)
    {
        // The Office add-in manifest requires https://localhost:47831, so this endpoint is
        // always HTTPS. LocalCertificate.Resolve falls back to a self-provisioned certificate
        // when the installer-provisioned PFX is missing so the port never serves plain HTTP.
        var certificate = LocalCertificate.Resolve(
            Environment.GetEnvironmentVariable("SHEET_AGENT_CERT_PATH"),
            Environment.GetEnvironmentVariable("SHEET_AGENT_CERT_PASSWORD"));
        var port = int.TryParse(Environment.GetEnvironmentVariable("SHEET_AGENT_PORT"), out var configuredPort) ? configuredPort : DefaultPort;
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, port, endpoint => endpoint.UseHttps(certificate)));
    }

    internal static void MapApi(WebApplication app)
    {
        var origins = new HashSet<string>((Environment.GetEnvironmentVariable("SHEET_AGENT_ALLOWED_ORIGINS") ?? "https://localhost:3000,https://localhost:47831").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries), StringComparer.OrdinalIgnoreCase);
        var pairing = app.Services.GetRequiredService<PairingService>();
        app.Use(async (context, next) =>
        {
            var origin = context.Request.Headers.Origin.ToString();
            if (!string.IsNullOrEmpty(origin) && !origins.Contains(origin)) { context.Response.StatusCode = 403; return; }
            if (!string.IsNullOrEmpty(origin)) context.Response.Headers.AccessControlAllowOrigin = origin;
            context.Response.Headers.AccessControlAllowHeaders = "Content-Type, X-Sheet-Agent-Token";
            context.Response.Headers.AccessControlAllowMethods = "GET, POST, DELETE, OPTIONS";
            if (context.Request.Method == "OPTIONS") { context.Response.StatusCode = 204; return; }
            var isProtected = context.Request.Path.StartsWithSegments("/v1/credentials");
            if (isProtected && !pairing.ValidateToken(context.Request.Headers["X-Sheet-Agent-Token"].ToString())) { context.Response.StatusCode = 401; return; }
            await next();
        });
        app.UseDefaultFiles();
        // Stage 24.5.2 §17 — HTML/JSON entry documents must NEVER be replayed from
        // cache: a stale taskpane.html would point Excel at an old bundle. The
        // content-hashed taskpane-<hash>.js is immutable and cached hard.
        app.UseStaticFiles(new StaticFileOptions
        {
            OnPrepareResponse = ctx =>
            {
                var name = ctx.File.Name;
                if (name.EndsWith(".html", StringComparison.OrdinalIgnoreCase)
                    || name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                {
                    ctx.Context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
                    ctx.Context.Response.Headers.Pragma = "no-cache";
                    ctx.Context.Response.Headers.Expires = "0";
                }
                else if (name.StartsWith("taskpane-", StringComparison.OrdinalIgnoreCase)
                         && name.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
                {
                    ctx.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
                }
            }
        });
        app.MapGet("/health", (ICredentialStore store, ProviderClient provider) => Results.Ok(new { status = "ok", application = "SheetAgent", version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3), build = BuildInfo.Describe(), provider = "litellm", model = provider.Model, configured = store.Exists("LLM_API_KEY") }));
        app.MapPost("/v1/session/pair", (PairingRequest request) => pairing.Exchange(request.Code) is { } token ? Results.Ok(new { token }) : Results.Unauthorized());
        app.MapGet("/v1/credentials/status", (ICredentialStore store) => Results.Ok(new { configured = store.Exists("LLM_API_KEY") }));
        app.MapPost("/v1/credentials", async (CredentialRequest request, ICredentialStore store) => { if (string.IsNullOrWhiteSpace(request.ApiKey)) return Results.BadRequest(); await store.SetAsync("LLM_API_KEY", request.ApiKey); return Results.NoContent(); });
        app.MapDelete("/v1/credentials", async (ICredentialStore store) => { await store.DeleteAsync("LLM_API_KEY"); return Results.NoContent(); });
        app.MapPost("/v1/chat", StreamChatAsync);
        app.MapPost("/v1/custom-functions", CompleteCustomFunctionsAsync);
        app.MapFallbackToFile("taskpane.html");
    }

    private static async Task StreamChatAsync(HttpContext context, ProviderClient provider)
    {
        try
        {
            using var body = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
            context.Response.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            await provider.StreamAsync(body.RootElement, async (delta, cancellationToken) =>
            {
                await context.Response.WriteAsync($"data: {JsonSerializer.Serialize(new { type = "delta", text = delta })}\n\n", cancellationToken);
                await context.Response.Body.FlushAsync(cancellationToken);
            }, context.RequestAborted);
            await context.Response.WriteAsync("data: {\"type\":\"done\"}\n\n", context.RequestAborted);
        }
        catch (JsonException) { await WriteErrorAsync(context, 400, "INVALID_JSON", "The request body must be valid JSON."); }
        catch (ProviderException error) { await WriteProviderErrorAsync(context, error); }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    }

    // The add-in serializes request bodies with camelCase property names. Default
    // System.Text.Json deserialization is case-sensitive and expects PascalCase, so
    // every /v1/custom-functions call previously failed with INVALID_BATCH. Web
    // defaults make property matching case-insensitive and camelCase-aware.
    internal static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    private static async Task<IResult> CompleteCustomFunctionsAsync(HttpContext context, ProviderClient provider)
    {
        try
        {
            var body = await JsonSerializer.DeserializeAsync<CustomFunctionBatch>(context.Request.Body, WebJson, context.RequestAborted);
            if (body?.Requests is not { Length: > 0 and <= 50 }) return Results.BadRequest(new { error = new { code = "INVALID_BATCH", message = "Submit between 1 and 50 functions per batch." } });
            using var concurrency = new SemaphoreSlim(4);
            var results = await Task.WhenAll(body.Requests.Select(async item =>
            {
                if (!CustomFunctionInstructions.TryGetValue(item.FunctionName ?? "", out var instruction) || item.Input is null) return "#INVALID!";
                await concurrency.WaitAsync(context.RequestAborted);
                try { return await provider.CompleteAsync(instruction, item.Input, context.RequestAborted); }
                catch (ProviderException error) { return error.Code switch { "CREDENTIALS_REQUIRED" or "INVALID_CREDENTIALS" => "#AUTH!", "RATE_LIMITED" => "#RATE!", "TIMEOUT" => "#TIMEOUT!", _ => "#AI!" }; }
                finally { concurrency.Release(); }
            }));
            return Results.Ok(new { results });
        }
        catch (JsonException) { return Results.BadRequest(new { error = new { code = "INVALID_JSON", message = "The request body must be valid JSON." } }); }
        catch (OperationCanceledException) { return Results.StatusCode(499); }
    }

    private static readonly IReadOnlyDictionary<string, string> CustomFunctionInstructions = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["AI"] = "Answer the request concisely.", ["AI.SUMMARIZE"] = "Summarize the input concisely.",
        ["AI.CLASSIFY"] = "Classify the input and return only the class.", ["AI.EXTRACT"] = "Extract requested information as compact JSON.",
        ["AI.TRANSLATE"] = "Translate the input as requested.", ["AI.CLEAN"] = "Clean and normalize the text without changing its meaning."
    };

    private static Task WriteProviderErrorAsync(HttpContext context, ProviderException error) => WriteErrorAsync(context, error.Code is "INVALID_REQUEST" ? 400 : error.Code is "CREDENTIALS_REQUIRED" ? 428 : 502, error.Code, error.Message);
    private static async Task WriteErrorAsync(HttpContext context, int status, string code, string message)
    {
        if (!context.Response.HasStarted) context.Response.StatusCode = status;
        context.Response.ContentType = "text/event-stream";
        await context.Response.WriteAsync($"data: {JsonSerializer.Serialize(new { type = "error", code, message })}\n\n");
    }
}
public sealed record PairingRequest(string Code);
public sealed record CredentialRequest(string ApiKey);
public sealed record CustomFunctionItem(string? FunctionName, string? Input);
public sealed record CustomFunctionBatch(CustomFunctionItem[] Requests);




