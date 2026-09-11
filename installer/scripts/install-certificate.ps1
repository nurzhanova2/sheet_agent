param([Parameter(Mandatory=$true)][string]$CertificateDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $CertificateDirectory | Out-Null
$existingThumbprintFile = Join-Path $CertificateDirectory 'thumbprint.txt'
$pfxPath = Join-Path $CertificateDirectory 'localhost.pfx'
if (Test-Path $existingThumbprintFile) {
  $oldThumbprint = (Get-Content $existingThumbprintFile -Raw).Trim()
  $personal = Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $oldThumbprint
  $trusted = Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $oldThumbprint
  if ($personal -and $personal.HasPrivateKey -and $trusted -and (Test-Path -LiteralPath $pfxPath)) { exit 0 }
  Get-ChildItem Cert:\CurrentUser\My,Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $oldThumbprint | Remove-Item -Force
}
$thumbprint = $null
try {
  $thumbprint = (& (Join-Path $PSScriptRoot 'new-local-certificate.ps1') -PfxPath $pfxPath | Select-Object -Last 1).ToString().Trim()
  $certificate = Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $thumbprint
  if (-not $certificate) { throw "Generated certificate $thumbprint is not present in Cert:\CurrentUser\My" }
  $cerPath = Join-Path $CertificateDirectory 'localhost.cer'
  Export-Certificate -Cert $certificate -FilePath $cerPath -Force | Out-Null
  Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
  Set-Content -LiteralPath $existingThumbprintFile -Value $thumbprint -NoNewline
  & icacls.exe $CertificateDirectory /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to protect certificate directory (icacls exit $LASTEXITCODE)" }
} catch {
  if ($thumbprint) { Get-ChildItem Cert:\CurrentUser\My,Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $thumbprint | Remove-Item -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
  throw
}
