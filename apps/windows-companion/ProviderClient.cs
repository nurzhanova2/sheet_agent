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

    public async Task StreamAsync(JsonElement requestBody, Func<string, CancellationToken, Task> onDelta, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(CreateProviderPayload(requestBody, stream: true), HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") break;
            try
            {
                using var json = JsonDocument.Parse(data);
                if (TryReadDelta(json.RootElement, out var delta) && delta.Length > 0) await onDelta(delta, cancellationToken);
            }
            catch (JsonException) { throw new ProviderException("MALFORMED_RESPONSE", "The AI provider returned an unreadable response."); }
        }
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

    private byte[] CreateProviderPayload(JsonElement requestBody, bool stream)
    {
        if (!requestBody.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array)
            throw new ProviderException("INVALID_REQUEST", "The request does not contain any messages.");
        return JsonSerializer.SerializeToUtf8Bytes(new { model = Model, stream, messages });
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
}
