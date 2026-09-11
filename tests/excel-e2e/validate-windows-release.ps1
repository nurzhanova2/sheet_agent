param(
  [string]$Installer = (Join-Path $PSScriptRoot '..\..\artifacts\installer\SheetAgentSetup-x64.exe'),
  [switch]$RequireSigned,
  [switch]$Install,
  [switch]$RunExcel,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$installerPath = [IO.Path]::GetFullPath($Installer)
if ([IO.Path]::GetFileName($installerPath) -ne 'SheetAgentSetup-x64.exe') { throw 'Installer must be named SheetAgentSetup-x64.exe.' }
if (-not (Test-Path -LiteralPath $installerPath)) { throw "Installer not found: $installerPath" }
$checksumPath = "$installerPath.sha256"
if (-not (Test-Path -LiteralPath $checksumPath)) { throw "Checksum not found: $checksumPath" }
$expected = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw "Checksum mismatch: expected $expected, got $actual" }
$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
if ($RequireSigned -and $signature.Status -ne 'Valid') { throw "Installer signature is not valid: $($signature.Status)" }
Write-Host "Artifact validation passed. SHA-256=$actual Authenticode=$($signature.Status)"
if ($Install) {
  $log = Join-Path $env:TEMP 'SheetAgent-e2e-install.log'
  $process = Start-Process -FilePath $installerPath -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=$log" -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed with exit $($process.ExitCode). Log: $log" }
  $app = Join-Path $env:LOCALAPPDATA 'Programs\SheetAgent\SheetAgent.exe'
  if (-not (Test-Path -LiteralPath $app)) { throw 'Installed Companion executable is missing.' }
  if (-not (Get-Process SheetAgent -ErrorAction SilentlyContinue)) { Start-Process -FilePath $app -WindowStyle Hidden; Start-Sleep -Seconds 3 }
  $health = Invoke-RestMethod -Uri 'https://localhost:47831/health' -TimeoutSec 10
  if ($health.status -ne 'ok') { throw 'Companion health check failed.' }
  $servedPlainHttp = $false
  try {
    if ((Invoke-WebRequest -Uri 'http://localhost:47831/health' -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200) { $servedPlainHttp = $true }
  } catch { }
  if ($servedPlainHttp) { throw 'Port 47831 is serving plain HTTP; the Office add-in requires HTTPS.' }
  $manifest = Join-Path $env:LOCALAPPDATA 'Programs\SheetAgent\manifest\manifest.windows.xml'
  $registered = Get-ItemProperty 'HKCU:\Software\Microsoft\Office\16.0\WEF\Developer' -ErrorAction Stop
  if (-not $registered.PSObject.Properties.Name.Contains($manifest)) { throw 'Excel add-in manifest registration is missing.' }
  Write-Host "Installation and localhost health validation passed. Log: $log"
}
if ($RunExcel) {
  if (-not $Install) { throw '-RunExcel requires -Install so the real installed integration is tested.' }
  $fixture = Join-Path $env:TEMP 'SheetAgent-large-workbook.xlsx'
  & "$PSScriptRoot\New-LargeWorkbookFixture.ps1" -Path $fixture -WorksheetCount 20 -RowsPerSheet 10000
  Write-Host 'Native workbook creation/save/reopen passed. Complete the visible add-in checks in tests/excel-e2e/README.md; this script does not claim UI success.'
}
if ($Uninstall) {
  $uninstaller = Join-Path $env:LOCALAPPDATA 'Programs\SheetAgent\unins000.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller not found.' }
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Uninstall failed with exit $($process.ExitCode)" }
  if (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\SheetAgent')) { throw 'Application directory remains after uninstall.' }
  if (Get-Process SheetAgent -ErrorAction SilentlyContinue) { throw 'SheetAgent process remains after uninstall.' }
  Write-Host 'Uninstall cleanup validation passed.'
}
