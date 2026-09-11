param([Parameter(Mandatory=$true)][string]$CertificateDirectory)
$ErrorActionPreference = 'SilentlyContinue'
$thumbprintFile = Join-Path $CertificateDirectory 'thumbprint.txt'
if (Test-Path $thumbprintFile) {
  $thumbprint = (Get-Content $thumbprintFile -Raw).Trim()
  Get-ChildItem Cert:\CurrentUser\My,Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $thumbprint | Remove-Item -Force
}
if (Test-Path $CertificateDirectory) { Remove-Item -LiteralPath $CertificateDirectory -Recurse -Force }
