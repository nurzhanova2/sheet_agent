using System.Reflection;

namespace SheetAgent.Companion;

/// <summary>
/// Stage 24.5.2 §1/§17 — reports which taskpane bundle the Companion is actually
/// serving from <c>wwwroot/assets</c>, so a manual tester can confirm Excel is
/// loading the new content-hashed bundle and not a cached one.
/// </summary>
public static class BuildInfo
{
    public static string TaskpaneBundle()
    {
        try
        {
            var assets = Path.Combine(AppContext.BaseDirectory, "wwwroot", "assets");
            if (!Directory.Exists(assets)) return "(none)";
            var hashed = Directory.GetFiles(assets, "taskpane-*.js");
            if (hashed.Length > 0) return Path.GetFileName(hashed[0]);
            var plain = Path.Combine(assets, "taskpane.js");
            return File.Exists(plain) ? "taskpane.js (unhashed)" : "(none)";
        }
        catch
        {
            return "(error)";
        }
    }

    public static object Describe() => new
    {
        version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3),
        taskpaneBundle = TaskpaneBundle()
    };
}
