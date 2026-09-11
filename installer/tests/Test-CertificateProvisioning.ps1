# Release gate for the Stage 19 Windows E2E bug.
#
# installer/scripts/new-local-certificate.ps1 previously passed the Subject Alternative Name
# to New-SelfSignedCertificate through BOTH -DnsName and -TextExtension, which fails at
# runtime ("DnsName parameter conflicts with supplied Subject Alternative Name extension").
# No localhost.pfx was produced, so the packaged Companion fell back to plain HTTP on port
# 47831 and Excel could not load the add-in.
#
# This gate mints the certificate exactly as the installer does and asserts the PFX exists
# with an exportable private key and a localhost + 127.0.0.1 SAN. A regression exits non-zero
# and fails the release build. It does not touch the trust store, so it is safe to run
# non-interactively in CI.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..\scripts\new-local-certificate.ps1'
$workDir = Join-Path ([IO.Path]::GetTempPath()) ("sheet-agent-cert-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$pfx = Join-Path $workDir 'localhost.pfx'
$thumbprint = $null
try {
  $thumbprint = (& $script -PfxPath $pfx | Select-Object -Last 1).ToString().Trim()
  if (-not (Test-Path -LiteralPath $pfx)) { throw "localhost.pfx was not created at $pfx" }

  $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $pfx, $null
  try {
    if (-not $certificate.HasPrivateKey) { throw 'Exported PFX has no private key (Kestrel would serve plain HTTP)' }
    if ($certificate.Thumbprint -ne $thumbprint) { throw 'Script returned a thumbprint that does not match the exported PFX' }
    $san = ($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }).Format($false)
    if ($san -notmatch 'localhost') { throw "Subject Alternative Name is missing localhost: $san" }
    if ($san -notmatch '127\.0\.0\.1') { throw "Subject Alternative Name is missing 127.0.0.1: $san" }
  } finally { $certificate.Dispose() }

  Write-Host "Certificate provisioning gate passed (thumbprint $thumbprint)."
}
finally {
  if ($thumbprint) {
    Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $thumbprint | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
}
