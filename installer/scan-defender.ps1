param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
$target = (Resolve-Path -LiteralPath $Path).Path
$candidates = @(
  "$env:ProgramFiles\Windows Defender\MpCmdRun.exe",
  "$env:ProgramData\Microsoft\Windows Defender\Platform\*\MpCmdRun.exe"
)
$scanner = Get-Item $candidates -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $scanner) { throw 'Windows Defender MpCmdRun.exe is not available on this machine.' }
& $scanner -Scan -ScanType 3 -File $target -DisableRemediation
if ($LASTEXITCODE -ne 0) { throw "Windows Defender scan failed or detected a threat (exit $LASTEXITCODE)." }
Write-Host "Windows Defender scan passed: $target"
