param(
  [Parameter(Mandatory=$true)][string]$AppDir,
  [Parameter(Mandatory=$true)][string]$WwwRoot,
  [int]$Port = 47861
)
# Release gate: assembles the real install layout, boots the published Companion
# against it, and asks for EVERY file the add-in ships. A payload that is present
# on disk but unservable over HTTP is invisible to a file-existence check and
# fatal in Excel: Stage 27.7 found the Python wheels 404ing because ".whl" is
# absent from the framework's content-type table, so Pyodide booted and then died
# fetching numpy. This gate fails the build on that class of defect.
$ErrorActionPreference = 'Stop'
$app = [IO.Path]::GetFullPath($AppDir)
$www = [IO.Path]::GetFullPath($WwwRoot)
if (-not (Test-Path -LiteralPath $app)) { throw "Companion app directory not found: $app" }
if (-not (Test-Path -LiteralPath $www)) { throw "wwwroot not found: $www" }

$workDir = Join-Path ([IO.Path]::GetTempPath()) ("sheet-agent-assets-gate-" + [Guid]::NewGuid().ToString('N'))
$layout = Join-Path $workDir 'layout'
$certDir = Join-Path $workDir 'certificate'
New-Item -ItemType Directory -Force -Path $layout, $certDir | Out-Null
$pfx = Join-Path $certDir 'localhost.pfx'
$process = $null
$thumbprint = $null
$priorCertPath = $env:SHEET_AGENT_CERT_PATH
$priorPort = $env:SHEET_AGENT_PORT

function Invoke-Head {
  param([int]$Port, [string]$Path)
  $tcp = New-Object Net.Sockets.TcpClient
  try {
    $tcp.Connect('127.0.0.1', $Port)
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, ([Net.Security.RemoteCertificateValidationCallback] { param($sender, $cert, $chain, $errors) $true }))
    try {
      $ssl.AuthenticateAsClient('localhost')
      $request = "HEAD $Path HTTP/1.1`r`nHost: localhost:$Port`r`nConnection: close`r`n`r`n"
      $bytes = [Text.Encoding]::ASCII.GetBytes($request)
      $ssl.Write($bytes, 0, $bytes.Length)
      $ssl.Flush()
      $reader = New-Object IO.StreamReader($ssl)
      $headers = $reader.ReadToEnd()
      $status = 0
      if ($headers -match '^HTTP/1\.\d\s+(\d{3})') { $status = [int]$Matches[1] }
      $length = -1
      if ($headers -match '(?im)^Content-Length:\s*(\d+)') { $length = [int64]$Matches[1] }
      $type = ''
      if ($headers -match '(?im)^Content-Type:\s*([^\r\n;]+)') { $type = $Matches[1].Trim() }
      return @{ Status = $status; Length = $length; Type = $type }
    } finally { $ssl.Dispose() }
  } finally { $tcp.Dispose() }
}

function ConvertTo-UrlPath {
  param([string]$Relative)
  $segments = $Relative -split '[\\/]+' | Where-Object { $_ -ne '' }
  $encoded = $segments | ForEach-Object { [Uri]::EscapeDataString($_) }
  return '/' + ($encoded -join '/')
}

try {
  Copy-Item -Path (Join-Path $app '*') -Destination $layout -Recurse -Force
  $layoutWwwRoot = Join-Path $layout 'wwwroot'
  if (Test-Path -LiteralPath $layoutWwwRoot) { Remove-Item -LiteralPath $layoutWwwRoot -Recurse -Force }
  Copy-Item -LiteralPath $www -Destination $layoutWwwRoot -Recurse -Force

  $exe = Join-Path $layout 'SheetAgent.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "Companion executable not found in the assembled layout: $exe" }

  $thumbprint = (& (Join-Path $PSScriptRoot '..\scripts\new-local-certificate.ps1') -PfxPath $pfx | Select-Object -Last 1).ToString().Trim()
  if (-not (Test-Path -LiteralPath $pfx)) { throw "Certificate was not created at $pfx" }

  $env:SHEET_AGENT_CERT_PATH = $pfx
  $env:SHEET_AGENT_PORT = "$Port"
  $process = Start-Process -FilePath $exe -ArgumentList '--background' -WindowStyle Hidden -PassThru

  $health = $null
  for ($i = 0; $i -lt 40 -and -not $health; $i++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw "Companion exited during startup with code $($process.ExitCode)" }
    try {
      $probe = Invoke-Head -Port $Port -Path '/health'
      if ($probe.Status -eq 200) { $health = $probe }
    } catch { $health = $null }
  }
  if (-not $health) { throw "https://localhost:$Port/health never answered; the asset gate could not run" }

  $files = Get-ChildItem -LiteralPath $layoutWwwRoot -Recurse -File
  if ($files.Count -eq 0) { throw "wwwroot is empty: nothing to serve" }

  $broken = @()
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($layoutWwwRoot.Length).TrimStart('\', '/')
    $url = ConvertTo-UrlPath $relative
    $response = Invoke-Head -Port $Port -Path $url
    if ($response.Status -ne 200) {
      $broken += "$relative -> HTTP $($response.Status)"
    } elseif ($response.Length -ge 0 -and $response.Length -ne $file.Length) {
      $broken += "$relative -> served $($response.Length) bytes, file is $($file.Length)"
    } elseif ([string]::IsNullOrWhiteSpace($response.Type)) {
      $broken += "$relative -> served with no Content-Type"
    }
  }

  if ($broken.Count -gt 0) {
    throw "The companion cannot serve $($broken.Count) of $($files.Count) payload files; the add-in would fail in Excel:`n  " + ($broken -join "`n  ")
  }

  $wheels = ($files | Where-Object { $_.Extension -eq '.whl' }).Count
  Write-Host "Sandbox asset gate passed: $($files.Count) payload files served over TLS, including $wheels Python wheels."
}
finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Get-Process SheetAgent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $layout 'SheetAgent.exe') } | Stop-Process -Force -ErrorAction SilentlyContinue
  $env:SHEET_AGENT_CERT_PATH = $priorCertPath
  $env:SHEET_AGENT_PORT = $priorPort
  if ($thumbprint) {
    Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $thumbprint | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
}
