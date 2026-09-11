param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$CertificatePath = $env:SHEET_AGENT_SIGNING_CERTIFICATE_PATH,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [switch]$RequireSigning
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) { throw "Signing target does not exist: $Path" }
if (-not $CertificatePath) {
  if ($RequireSigning) { throw 'Production signing is required. Set SHEET_AGENT_SIGNING_CERTIFICATE_PATH and SHEET_AGENT_SIGNING_CERTIFICATE_PASSWORD.' }
  Write-Host "Signing skipped for $Path (no certificate configured)."
  exit 0
}
if (-not (Test-Path -LiteralPath $CertificatePath)) { throw "Signing certificate does not exist: $CertificatePath" }
if (-not $env:SHEET_AGENT_SIGNING_CERTIFICATE_PASSWORD) { throw 'SHEET_AGENT_SIGNING_CERTIFICATE_PASSWORD is required.' }
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$signTool = Get-ChildItem -LiteralPath $kitsRoot -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
  Where-Object FullName -Match '\\x64\\signtool\.exe$' | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $signTool) { throw 'signtool.exe was not found. Install the Windows SDK signing tools.' }
& $signTool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /f $CertificatePath /p $env:SHEET_AGENT_SIGNING_CERTIFICATE_PASSWORD $Path
if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE" }
& $signTool verify /pa /v $Path
if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed with exit code $LASTEXITCODE" }
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid') { throw "PowerShell Authenticode verification failed: $($signature.Status)" }
