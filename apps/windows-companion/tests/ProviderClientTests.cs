using System.Net;
using System.Text;
using SheetAgent.Companion;
using Xunit;

namespace SheetAgent.Companion.Tests;

public sealed class ProviderClientTests
{
    [Fact]
    public async Task Streams_OpenAI_compatible_deltas_without_exposing_key()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("data: {\"choices\":[{\"delta\":{\"content\":\"Ready\"}}]}\n\ndata: [DONE]\n\n")
        });
        var client = new ProviderClient(new MemoryCredentials("secret-value"), new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) });
        var output = "";
        using var json = System.Text.Json.JsonDocument.Parse("{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}");
        await client.StreamAsync(json.RootElement, (delta, _) => { output += delta; return Task.CompletedTask; }, CancellationToken.None);
        Assert.Equal("Ready", output);
        Assert.Equal("Bearer", handler.AuthorizationScheme);
        Assert.Equal("secret-value", handler.AuthorizationValue);
    }

    [Fact]
    public async Task Forwards_generation_parameters_within_bounds_and_drops_the_rest()
    {
        // Stage 27.2 §7. Until this stage the payload was
        // `new { model, stream, messages }`, so temperature, top_p and seed
        // never reached the provider and its own defaults applied. Measured
        // through the production path, three identical requests returned
        // 618392 / 482917 / 482915 - which is also why identical code produced
        // materially different benchmark outcomes (§0).
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n")
        });
        var client = new ProviderClient(new MemoryCredentials("secret"), new HttpClient(handler));
        using var json = System.Text.Json.JsonDocument.Parse(
            "{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]," +
            "\"temperature\":0.1,\"top_p\":0.9,\"seed\":12345,\"max_tokens\":512," +
            // Out of range, wrong type, and not on the allow-list: all dropped.
            "\"presence_penalty\":99,\"frequency_penalty\":\"high\",\"tools\":[{\"type\":\"function\"}]," +
            // The model is the companion's own configuration, never the page's.
            "\"model\":\"attacker/model\"}");
        await client.StreamAsync(json.RootElement, (_, _) => Task.CompletedTask, CancellationToken.None);

        using var sent = System.Text.Json.JsonDocument.Parse(handler.RequestBody!);
        var root = sent.RootElement;
        Assert.Equal(0.1, root.GetProperty("temperature").GetDouble(), 6);
        Assert.Equal(0.9, root.GetProperty("top_p").GetDouble(), 6);
        Assert.Equal(12345, root.GetProperty("seed").GetInt64());
        Assert.Equal(512, root.GetProperty("max_tokens").GetInt32());
        Assert.False(root.TryGetProperty("presence_penalty", out _));
        Assert.False(root.TryGetProperty("frequency_penalty", out _));
        Assert.False(root.TryGetProperty("tools", out _));
        Assert.Equal(ProviderClient.DefaultModel, root.GetProperty("model").GetString());
    }

    [Fact]
    public async Task Omits_generation_parameters_that_were_not_requested()
    {
        // A request that sets nothing must produce exactly the payload the
        // companion sent before this stage, so the change cannot alter the
        // behaviour of any caller that has not opted in.
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("data: [DONE]\n\n")
        });
        var client = new ProviderClient(new MemoryCredentials("secret"), new HttpClient(handler));
        using var json = System.Text.Json.JsonDocument.Parse("{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}");
        await client.StreamAsync(json.RootElement, (_, _) => Task.CompletedTask, CancellationToken.None);

        using var sent = System.Text.Json.JsonDocument.Parse(handler.RequestBody!);
        Assert.Equal(3, sent.RootElement.EnumerateObject().Count());
        Assert.False(sent.RootElement.TryGetProperty("temperature", out _));
        Assert.False(sent.RootElement.TryGetProperty("seed", out _));
    }

    [Fact]
    public async Task Maps_auth_failure_to_actionable_redacted_error()
    {
        var client = new ProviderClient(new MemoryCredentials("do-not-leak"), new HttpClient(new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("do-not-leak") })));
        var error = await Assert.ThrowsAsync<ProviderException>(() => client.CompleteAsync("system", "input", CancellationToken.None));
        Assert.Equal("INVALID_CREDENTIALS", error.Code);
        Assert.DoesNotContain("do-not-leak", error.Message);
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests, "RATE_LIMITED")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "PROVIDER_UNAVAILABLE")]
    public async Task Maps_provider_failures(HttpStatusCode status, string expectedCode)
    {
        var client = new ProviderClient(new MemoryCredentials("secret"), new HttpClient(new StubHandler(_ => new HttpResponseMessage(status))));
        var error = await Assert.ThrowsAsync<ProviderException>(() => client.CompleteAsync("system", "input", CancellationToken.None));
        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task Rejects_malformed_provider_response()
    {
        var client = new ProviderClient(new MemoryCredentials("secret"), new HttpClient(new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("not-json") })));
        var error = await Assert.ThrowsAsync<ProviderException>(() => client.CompleteAsync("system", "input", CancellationToken.None));
        Assert.Equal("MALFORMED_RESPONSE", error.Code);
    }

    [Fact]
    public async Task Requires_credentials_without_network_traffic()
    {
        var handler = new StubHandler(_ => throw new InvalidOperationException("network must not run"));
        var client = new ProviderClient(new MemoryCredentials(null), new HttpClient(handler));
        var error = await Assert.ThrowsAsync<ProviderException>(() => client.CompleteAsync("system", "input", CancellationToken.None));
        Assert.Equal("CREDENTIALS_REQUIRED", error.Code);
    }

    private sealed class MemoryCredentials(string? key) : ICredentialStore
    {
        public bool Exists(string name) => key is not null;
        public Task<string?> GetAsync(string name) => Task.FromResult(key);
        public Task SetAsync(string name, string value) => Task.CompletedTask;
        public Task DeleteAsync(string name) => Task.CompletedTask;
    }

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public string? AuthorizationScheme { get; private set; }
        public string? AuthorizationValue { get; private set; }
        /// <summary>Stage 27.2 §7 — the exact bytes sent upstream, so a test can assert what was forwarded AND what was not.</summary>
        public string? RequestBody { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            AuthorizationScheme = request.Headers.Authorization?.Scheme;
            AuthorizationValue = request.Headers.Authorization?.Parameter;
            RequestBody = request.Content?.ReadAsStringAsync(cancellationToken).GetAwaiter().GetResult();
            return Task.FromResult(respond(request));
        }
    }
}
