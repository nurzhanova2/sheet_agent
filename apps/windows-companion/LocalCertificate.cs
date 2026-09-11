using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace SheetAgent.Companion;

/// <summary>
/// Resolves the X.509 certificate that Kestrel binds to the loopback endpoint.
/// The Office add-in manifest (manifest.windows.xml) hard-codes https://localhost:47831,
/// so this endpoint must always complete a TLS handshake. The installer provisions and
/// trusts a per-user certificate; when that file is absent or unusable the Companion
/// generates a self-signed certificate itself so the port still speaks TLS and can never
/// silently downgrade to plain HTTP.
/// </summary>
public static class LocalCertificate
{
    public static string DefaultPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SheetAgent", "certificate", "localhost.pfx");

    public static X509Certificate2 Resolve(string? certificatePath = null, string? certificatePassword = null)
    {
        var path = string.IsNullOrWhiteSpace(certificatePath) ? DefaultPath : certificatePath;
        return Load(path, certificatePassword) ?? Provision(path);
    }

    private static X509Certificate2? Load(string path, string? password)
    {
        if (!File.Exists(path)) return null;
        try
        {
            var certificate = new X509Certificate2(path, password);
            if (certificate.HasPrivateKey) return certificate;
            certificate.Dispose();
        }
        catch (CryptographicException)
        {
            // Corrupt or unreadable PFX: fall back to self-provisioning below.
        }
        return null;
    }

    private static X509Certificate2 Provision(string path)
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        var subjectAlternativeNames = new SubjectAlternativeNameBuilder();
        subjectAlternativeNames.AddDnsName("localhost");
        subjectAlternativeNames.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(subjectAlternativeNames.Build());

        var now = DateTimeOffset.UtcNow;
        using var generated = request.CreateSelfSigned(now.AddDays(-1), now.AddYears(3));
        var exported = generated.Export(X509ContentType.Pfx);
        TryPersist(path, exported);
        return new X509Certificate2(exported);
    }

    private static void TryPersist(string path, byte[] pfx)
    {
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.WriteAllBytes(path, pfx);
        }
        catch (IOException)
        {
            // The certificate still works in-memory for this process; persistence is best effort.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
