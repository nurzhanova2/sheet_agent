param(
  [Parameter(Mandatory=$true)][string]$PfxPath,
  [string]$PfxPassword
)
# Creates the localhost TLS certificate the Companion binds to https://localhost:47831 and
# exports it (with its private key) to $PfxPath. Trust installation is the caller's job.
#
# The Subject Alternative Name is supplied ONLY through -TextExtension (DNS=localhost +
# IP=127.0.0.1). Passing -DnsName as well makes New-SelfSignedCertificate fail with
# "DnsName parameter conflicts with supplied Subject Alternative Name extension", which
# left machines with no localhost.pfx and forced Kestrel onto plain HTTP (Stage 19 E2E bug).
$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $PfxPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$certificate = New-SelfSignedCertificate -Subject 'CN=localhost' -CertStoreLocation 'Cert:\CurrentUser\My' -FriendlyName 'Sheet Agent Localhost' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3) -TextExtension @('2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1','2.5.29.19={text}CA=false','2.5.29.37={text}1.3.6.1.5.5.7.3.1')
try {
  if (-not $certificate.HasPrivateKey) { throw 'Generated certificate has no private key' }
  $type = [Security.Cryptography.X509Certificates.X509ContentType]::Pfx
  $bytes = if ($PfxPassword) { $certificate.Export($type, $PfxPassword) } else { $certificate.Export($type) }
  [IO.File]::WriteAllBytes($PfxPath, $bytes)
  $verify = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $PfxPath, $PfxPassword
  try {
    if (-not $verify.HasPrivateKey) { throw "Exported PFX at $PfxPath does not contain a private key" }
    $san = ($verify.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }).Format($false)
    if ($san -notmatch 'localhost') { throw "Exported PFX is missing the localhost Subject Alternative Name: $san" }
  } finally { $verify.Dispose() }
} catch {
  Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $certificate.Thumbprint | Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PfxPath -Force -ErrorAction SilentlyContinue
  throw
}
$certificate.Thumbprint
