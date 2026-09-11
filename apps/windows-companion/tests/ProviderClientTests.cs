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
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            AuthorizationScheme = request.Headers.Authorization?.Scheme;
            AuthorizationValue = request.Headers.Authorization?.Parameter;
            return Task.FromResult(respond(request));
        }
    }
}
