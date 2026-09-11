using Microsoft.Win32;
namespace SheetAgent.Companion;
public sealed class StartupManager
{
    private const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "SheetAgent";
    public bool IsEnabled { get { using var key = Registry.CurrentUser.OpenSubKey(RegistryPath); return key?.GetValue(ValueName) is string; } }
    public void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RegistryPath);
        if (enabled) key.SetValue(ValueName, $"\"{Environment.ProcessPath}\" --background");
        else key.DeleteValue(ValueName, false);
    }
}
