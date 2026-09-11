using System.Security.Cryptography;
using System.Text;

namespace SheetAgent.Companion;

public sealed class PairingService
{
    private readonly object gate = new();
    private string pairingCode = CreateCode();
    private byte[]? tokenHash;
    public string CurrentCode { get { lock (gate) return pairingCode; } }
    public string? Exchange(string candidate)
    {
        lock (gate)
        {
            if (!FixedEquals(pairingCode, candidate)) return null;
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
            pairingCode = CreateCode();
            return token;
        }
    }
    public bool ValidateToken(string candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate)) return false;
        lock (gate) return tokenHash is not null && CryptographicOperations.FixedTimeEquals(tokenHash, SHA256.HashData(Encoding.UTF8.GetBytes(candidate)));
    }
    private static string CreateCode() => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
    private static bool FixedEquals(string left, string right) => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(left), Encoding.UTF8.GetBytes(right));
}
