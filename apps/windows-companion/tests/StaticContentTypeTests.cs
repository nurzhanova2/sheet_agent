using Xunit;

namespace SheetAgent.Companion.Tests;

public sealed class StaticContentTypeTests
{
    [Fact]
    public void Serves_python_wheels()
    {
        var provider = Program.StaticContentTypes();

        Assert.True(provider.TryGetContentType("numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl", out var contentType));
        Assert.Equal("application/octet-stream", contentType);
    }

    [Fact]
    public void Serves_every_extension_the_pyodide_payload_ships()
    {
        var payload = VendoredPyodideDirectory();
        var provider = Program.StaticContentTypes();

        var files = Directory.GetFiles(payload);
        Assert.NotEmpty(files);

        var unservable = files
            .Where(file => !provider.TryGetContentType(Path.GetFileName(file), out _))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(unservable);
    }

    [Fact]
    public void Keeps_the_framework_defaults()
    {
        var provider = Program.StaticContentTypes();

        Assert.True(provider.TryGetContentType("taskpane.html", out var html));
        Assert.StartsWith("text/html", html);
        Assert.True(provider.TryGetContentType("taskpane.js", out _));
        Assert.True(provider.TryGetContentType("pyodide-lock.json", out var json));
        Assert.Equal("application/json", json);
    }

    private static string VendoredPyodideDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "apps", "addin", "public", "pyodide");
            if (Directory.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("apps/addin/public/pyodide was not found above " + AppContext.BaseDirectory);
    }
}
