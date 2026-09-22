param(
  [string]$Configuration = 'Release',
  [string]$Version = '0.3.0',
  [string]$InnoCompiler = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  [string]$SigningCertificatePath = $env:SHEET_AGENT_SIGNING_CERTIFICATE_PATH,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  # Stage 26.8 §10/§45 — the HUMAN TESTING RC ships with the unified analytical
  # engine ON. Pass -UnifiedAnalyticalEngineV2:$false to build the rollback
  # installer, which restores Stage 24/25 production routing exactly.
  [bool]$UnifiedAnalyticalEngineV2 = $true,
  [switch]$RequireSigning
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stage = Join-Path $repository 'artifacts\installer-stage'
$output = Join-Path $repository 'artifacts\installer'
$dotnet = Join-Path $repository '.dotnet\dotnet.exe'
if (-not (Test-Path $dotnet)) { $dotnet = 'dotnet' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must use major.minor.patch format: $Version" }
function Invoke-Checked {
  param([scriptblock]$Command, [string]$Description)
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force "$stage\app", "$stage\wwwroot", "$stage\manifest", "$stage\scripts", $output | Out-Null
Push-Location $repository
try {
  $env:VITE_API_BASE_URL = 'https://localhost:47831'
  # Stage 26.8 §9/§10/§54 — baked into the bundle and reported by /debug, so a
  # manual tester can see which engine the build they installed actually uses.
  $env:VITE_UNIFIED_ANALYTICAL_ENGINE_V2 = if ($UnifiedAnalyticalEngineV2) { 'true' } else { 'false' }
  Write-Host "Unified analytical engine V2: $($env:VITE_UNIFIED_ANALYTICAL_ENGINE_V2)"
  # Stage 24.5.2 §1/§17 — a deterministic, provable build id baked into the
  # content-hashed taskpane bundle (see apps/addin/vite.config.ts).
  $gitShort = (& git -C $repository rev-parse --short=12 HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $gitShort) { $gitShort = 'unknown' }
  $env:SHEET_AGENT_GIT_COMMIT = $gitShort
  $env:SHEET_AGENT_BUILD_ID = "$Version+$gitShort." + ((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))
  Invoke-Checked { corepack pnpm --filter @sheet-agent/addin build } 'React/Vite build'
  Invoke-Checked { corepack pnpm exec office-addin-manifest validate 'apps/addin/manifest/manifest.windows.xml' } 'Office manifest validation'
  Invoke-Checked { & $dotnet test 'apps/windows-companion/tests/SheetAgent.Companion.Tests.csproj' -c $Configuration } 'Companion tests'
  & "$PSScriptRoot\tests\Test-CertificateProvisioning.ps1"
  Invoke-Checked { & $dotnet publish 'apps/windows-companion/SheetAgent.Companion.csproj' -c $Configuration -r win-x64 --self-contained true -p:PublishSingleFile=true -p:Version=$Version -o "$stage\app" } 'Companion publish'
  Copy-Item 'apps/addin/dist/*' "$stage\wwwroot" -Recurse -Force
  Copy-Item 'apps/addin/manifest/manifest.windows.xml' "$stage\manifest\manifest.windows.xml" -Force
  $manifestPath = "$stage\manifest\manifest.windows.xml"
  $manifestVersion = "$Version.0"
  $manifest = Get-Content -LiteralPath $manifestPath -Raw
  $manifest = $manifest -replace '<Version>[^<]+</Version>', "<Version>$manifestVersion</Version>"
  Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding utf8
  Copy-Item 'installer/scripts/*' "$stage\scripts" -Force
  foreach ($required in @("$stage\app\SheetAgent.exe", "$stage\wwwroot\taskpane.html", "$stage\wwwroot\assets\customFunctions.js", "$stage\wwwroot\custom-functions.json", "$stage\manifest\manifest.windows.xml")) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required installer payload is missing: $required" }
  }
  & "$PSScriptRoot\tests\Assert-CompanionHttps.ps1" -CompanionExe "$stage\app\SheetAgent.exe"
  if (-not (Test-Path $InnoCompiler)) { throw "Inno Setup compiler not found: $InnoCompiler" }
  if ($RequireSigning -or $SigningCertificatePath) {
    & "$PSScriptRoot\sign-artifact.ps1" -Path "$stage\app\SheetAgent.exe" -CertificatePath $SigningCertificatePath -TimestampUrl $TimestampUrl -RequireSigning:$RequireSigning
  }
  Invoke-Checked { & $InnoCompiler "/DStageDir=$stage" "/DOutputDir=$output" "/DProductVersion=$Version" 'installer/SheetAgent.utf8.iss' } 'Inno Setup compilation'
  $installer = Join-Path $output 'SheetAgentSetup-x64.exe'
  if ($RequireSigning -or $SigningCertificatePath) {
    & "$PSScriptRoot\sign-artifact.ps1" -Path $installer -CertificatePath $SigningCertificatePath -TimestampUrl $TimestampUrl -RequireSigning:$RequireSigning
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($RequireSigning -and $signature.Status -ne 'Valid') { throw "Production signing verification failed: $($signature.Status)" }
  $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$installer.sha256" -Value "$hash  SheetAgentSetup-x64.exe" -Encoding ascii
  Write-Host "Release artifact: $installer"
  Write-Host "Authenticode: $($signature.Status)"
  Write-Host "SHA-256: $hash"
  Write-Host "Unified analytical engine V2: $($env:VITE_UNIFIED_ANALYTICAL_ENGINE_V2)"
} finally {
  Pop-Location
}
