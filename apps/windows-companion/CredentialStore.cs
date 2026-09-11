using System.Security.Cryptography;
using System.Text;

namespace SheetAgent.Companion;

public interface ICredentialStore
{
    bool Exists(string name);
    Task SetAsync(string name, string value);
    Task<string?> GetAsync(string name);
    Task DeleteAsync(string name);
}

public sealed class DpapiCredentialStore : ICredentialStore
{
    private readonly string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SheetAgent", "credentials");
    private string PathFor(string name) => Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(name))) + ".bin");
    public bool Exists(string name) => File.Exists(PathFor(name));
    public async Task SetAsync(string name, string value) { Directory.CreateDirectory(directory); var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser); await File.WriteAllBytesAsync(PathFor(name), protectedBytes); }
    public async Task<string?> GetAsync(string name) { var path = PathFor(name); if (!File.Exists(path)) return null; var protectedBytes = await File.ReadAllBytesAsync(path); return Encoding.UTF8.GetString(ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.CurrentUser)); }
    public Task DeleteAsync(string name) { var path = PathFor(name); if (File.Exists(path)) File.Delete(path); return Task.CompletedTask; }
}
