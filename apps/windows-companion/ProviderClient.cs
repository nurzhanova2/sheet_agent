using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace SheetAgent.Companion;

public sealed class ProviderException(string code, string userMessage, HttpStatusCode? statusCode = null) : Exception(userMessage)
{
    public string Code { get; } = code;
    public HttpStatusCode? StatusCode { get; } = statusCode;
}

public sealed record StreamStats(int ContentLength, int ReasoningLength, long ElapsedMs, string? FinishReason);

public sealed class ProviderClient
{
    public const string DefaultApiBase = "https://prod-litellm.nationalbank.kz/";
    public const string DefaultModel = "Qwen/Qwen3.5-35B-A3B-FP8";
    private readonly ICredentialStore credentials;
    private readonly HttpClient http;
    private readonly Uri endpoint;
    public string Model { get; }

    public ProviderClient(ICredentialStore credentials, HttpClient http)
    {
        this.credentials = credentials;
        this.http = http;
        var apiBaseText = Environment.GetEnvironmentVariable("LLM_API_BASE") ?? DefaultApiBase;
        if (!Uri.TryCreate(apiBaseText.EndsWith('/') ? apiBaseText : apiBaseText + "/", UriKind.Absolute, out var apiBase) || apiBase.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("LLM_API_BASE must be an absolute HTTPS URL.");
        endpoint = new Uri(apiBase, "v1/chat/completions");
        Model = Environment.GetEnvironmentVariable("LLM_MODEL")?.Trim() is { Length: > 0 } model ? model : DefaultModel;
    }

    public async Task<StreamStats> StreamAsync(JsonElement requestBody, Func<string, CancellationToken, Task> onDelta, CancellationToken cancellationToken)
    {
        var started = DateTimeOffset.UtcNow;
        using var response = await SendAsync(CreateProviderPayload(requestBody, stream: true), HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        var contentLength = 0;
        var reasoningLength = 0;
        string? finishReason = null;
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") break;
            try
            {
                using var json = JsonDocument.Parse(data);
                reasoningLength += ReadReasoningLength(json.RootElement);
                finishReason = ReadFinishReason(json.RootElement) ?? finishReason;
                if (TryReadDelta(json.RootElement, out var delta) && delta.Length > 0)
                {
                    contentLength += delta.Length;
                    await onDelta(delta, cancellationToken);
                }
            }
            catch (JsonException) { throw new ProviderException("MALFORMED_RESPONSE", "The AI provider returned an unreadable response."); }
        }

        if (contentLength == 0 && reasoningLength > 0)
            throw new ProviderException("EMPTY_MODEL_OUTPUT", "The AI provider produced reasoning text but no usable content.");

        return new StreamStats(contentLength, reasoningLength, (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds, finishReason);
    }

    public async Task<string> CompleteAsync(string systemPrompt, string input, CancellationToken cancellationToken)
    {
        var payload = new
        {
            model = Model,
            stream = false,
            messages = new[] { new { role = "system", content = systemPrompt }, new { role = "user", content = input[..Math.Min(input.Length, 8_000)] } }
        };
        using var response = await SendAsync(JsonSerializer.SerializeToUtf8Bytes(payload), HttpCompletionOption.ResponseContentRead, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        try
        {
            using var json = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(cancellationToken));
            var content = json.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
            return string.IsNullOrWhiteSpace(content) ? throw new JsonException() : content;
        }
        catch (JsonException) { throw new ProviderException("MALFORMED_RESPONSE", "The AI provider returned an unreadable response."); }
    }

    /// <summary>
    /// Stage 27.2 §7 — generation parameters the add-in may set per role.
    ///
    /// Everything the client sends used to be discarded except `messages`, and
    /// that single line was the cause of a measured problem: with no
    /// temperature reaching the provider, the deployment's own default applied,
    /// and three identical requests through this path returned 618392, 482917
    /// and 482915 for "invent a 6-digit number". Identical code produced
    /// materially different benchmark outcomes for the same reason, which is
    /// why Stage 27.2 §0 stops treating live runs as precise measurements.
    ///
    /// The allow-list stays SHORT and is validated here rather than trusted.
    /// A local caller is not automatically a safe one: an out-of-range value
    /// forwarded verbatim earns a provider 400 that surfaces to the user as a
    /// generic failure, so each entry is bounds-checked and silently omitted
    /// when it does not make sense.
    ///
    /// `model` is deliberately NOT taken from the request. Which model this
    /// companion talks to is its own configuration (env or default), and
    /// letting a page choose would make the trust boundary decorative.
    ///
    /// `tools` is deliberately NOT forwarded — see the audit. Forwarding tool
    /// definitions without also reading `delta.tool_calls` and round-tripping
    /// assistant tool-call messages would advertise a capability that silently
    /// produces nothing, which is worse than not offering it.
    /// </summary>
    private static readonly (string Name, double Min, double Max)[] NumericPassThrough =
    [
        ("temperature", 0d, 2d),
        ("top_p", 0d, 1d),
        ("presence_penalty", -2d, 2d),
        ("frequency_penalty", -2d, 2d),
    ];

    private byte[] CreateProviderPayload(JsonElement requestBody, bool stream)
    {
        if (!requestBody.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array)
            throw new ProviderException("INVALID_REQUEST", "The request does not contain any messages.");

        var payload = new Dictionary<string, object?>
        {
            ["model"] = Model,
            ["stream"] = stream,
            ["messages"] = messages,
        };

        foreach (var (name, min, max) in NumericPassThrough)
        {
            if (requestBody.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
                && value.TryGetDouble(out var number) && !double.IsNaN(number) && number >= min && number <= max)
            {
                payload[name] = number;
            }
        }

        // Integers, bounds-checked separately: a fractional seed or a negative
        // token budget is a client bug, not an instruction to pass along.
        if (requestBody.TryGetProperty("seed", out var seed) && seed.ValueKind == JsonValueKind.Number && seed.TryGetInt64(out var seedValue))
            payload["seed"] = seedValue;
        if (requestBody.TryGetProperty("max_tokens", out var maxTokens) && maxTokens.ValueKind == JsonValueKind.Number
            && maxTokens.TryGetInt32(out var maxTokensValue) && maxTokensValue > 0)
            payload["max_tokens"] = maxTokensValue;

        return JsonSerializer.SerializeToUtf8Bytes(payload);
    }

    private async Task<HttpResponseMessage> SendAsync(byte[] payload, HttpCompletionOption option, CancellationToken cancellationToken)
    {
        var key = await credentials.GetAsync("LLM_API_KEY");
        if (string.IsNullOrWhiteSpace(key)) throw new ProviderException("CREDENTIALS_REQUIRED", "Open Sheet Agent settings and save your AI provider API key.");
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = new ByteArrayContent(payload) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        try { return await http.SendAsync(request, option, cancellationToken); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new ProviderException("TIMEOUT", "The AI provider timed out. Try again."); }
        catch (HttpRequestException) { throw new ProviderException("NETWORK_UNAVAILABLE", "The AI provider cannot be reached. Check your network and provider URL."); }
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode) return;
        _ = await response.Content.ReadAsByteArrayAsync(cancellationToken); // drain without exposing provider content or credentials
        var (code, message) = response.StatusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => ("INVALID_CREDENTIALS", "The AI provider rejected the API key. Update it in Sheet Agent settings."),
            (HttpStatusCode)429 => ("RATE_LIMITED", "The AI provider is busy or rate-limited. Wait and try again."),
            >= HttpStatusCode.InternalServerError => ("PROVIDER_UNAVAILABLE", "The AI provider is temporarily unavailable. Try again later."),
            _ => ("PROVIDER_ERROR", $"The AI provider rejected the request ({(int)response.StatusCode}).")
        };
        throw new ProviderException(code, message, response.StatusCode);
    }

    private static bool TryReadDelta(JsonElement root, out string delta)
    {
        delta = "";
        if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0) return false;
        var choice = choices[0];
        if (!choice.TryGetProperty("delta", out var deltaObject) || !deltaObject.TryGetProperty("content", out var content)) return false;
        delta = content.GetString() ?? "";
        return true;
    }

    private static string? ReadFinishReason(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0) return null;
        var choice = choices[0];
        if (!choice.TryGetProperty("finish_reason", out var reason) || reason.ValueKind != JsonValueKind.String) return null;
        return reason.GetString();
    }

    private static int ReadReasoningLength(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0) return 0;
        var choice = choices[0];
        if (!choice.TryGetProperty("delta", out var deltaObject) || !deltaObject.TryGetProperty("reasoning_content", out var reasoning)) return 0;
        return reasoning.GetString()?.Length ?? 0;
    }
}
