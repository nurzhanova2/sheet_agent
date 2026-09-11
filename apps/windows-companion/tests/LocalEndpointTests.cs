using System.Net;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using SheetAgent.Companion;
using Xunit;

namespace SheetAgent.Companion.Tests;

// These tests mutate process-wide environment variables, so they must not run in parallel
// with anything else that reads them.
[Collection("LocalEndpoint")]
public sealed class LocalEndpointTests
{
    [Fact]
    public void Resolve_without_installed_pfx_provisions_https_capable_certificate()
    {
        var directory = Path.Combine(Path.GetTempPath(), "sheet-agent-cert-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "localhost.pfx");
        try
        {
            using var certificate = LocalCertificate.Resolve(path, null);

            Assert.True(certificate.HasPrivateKey);
            Assert.True(File.Exists(path));
            var subjectAlternativeName = certificate.Extensions
                .First(extension => extension.Oid?.Value == "2.5.29.17")
                .Format(false);
            Assert.Contains("localhost", subjectAlternativeName);

            // A second call must reuse the persisted certificate rather than minting a new one.
            using var reloaded = LocalCertificate.Resolve(path, null);
            Assert.Equal(certificate.Thumbprint, reloaded.Thumbprint);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }

    [Fact]
    public async Task ConfigureLocalEndpoint_binds_https_only_and_refuses_plain_http()
    {
        var directory = Path.Combine(Path.GetTempPath(), "sheet-agent-cert-" + Guid.NewGuid().ToString("N"));
        var previousPort = Environment.GetEnvironmentVariable("SHEET_AGENT_PORT");
        var previousCertPath = Environment.GetEnvironmentVariable("SHEET_AGENT_CERT_PATH");
        try
        {
            Environment.SetEnvironmentVariable("SHEET_AGENT_PORT", "0"); // ephemeral port, avoids clashing with a running Companion
            Environment.SetEnvironmentVariable("SHEET_AGENT_CERT_PATH", Path.Combine(directory, "localhost.pfx"));

            var builder = WebApplication.CreateSlimBuilder();
            Program.ConfigureLocalEndpoint(builder);
            await using var app = builder.Build();
            app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
            await app.StartAsync();
            var port = new Uri(app.Urls.First()).Port;

            using var tlsHandler = new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback = (_, _, _, _) => true
            };
            using var httpsClient = new HttpClient(tlsHandler);
            var body = await httpsClient.GetStringAsync($"https://127.0.0.1:{port}/health");
            Assert.Contains("ok", body);

            using var plainClient = new HttpClient();
            await Assert.ThrowsAnyAsync<HttpRequestException>(
                () => plainClient.GetAsync($"http://127.0.0.1:{port}/health"));

            await app.StopAsync();
        }
        finally
        {
            Environment.SetEnvironmentVariable("SHEET_AGENT_PORT", previousPort);
            Environment.SetEnvironmentVariable("SHEET_AGENT_CERT_PATH", previousCertPath);
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }
}
