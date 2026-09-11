param(
  [Parameter(Mandatory=$true)][string]$CompanionExe,
  [int]$Port = 47859
)
# Release gate: boots the freshly published Companion and proves the loopback endpoint
# completes a TLS handshake and does NOT serve plain HTTP. Regressing the Kestrel HTTPS
# configuration (the Stage 19 Windows E2E bug) makes this exit non-zero and fails the build.
# Uses raw sockets so it behaves identically on Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
$exe = [IO.Path]::GetFullPath($CompanionExe)
if (-not (Test-Path -LiteralPath $exe)) { throw "Companion executable not found: $exe" }

$workDir = Join-Path ([IO.Path]::GetTempPath()) ("sheet-agent-https-gate-" + [Guid]::NewGuid().ToString('N'))
$certDir = Join-Path $workDir 'certificate'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$pfx = Join-Path $certDir 'localhost.pfx'
$process = $null
$thumbprint = $null
$priorCertPath = $env:SHEET_AGENT_CERT_PATH
$priorPort = $env:SHEET_AGENT_PORT

function Invoke-HealthOverTls {
  param([int]$Port)
  $tcp = New-Object Net.Sockets.TcpClient
  try {
    $tcp.Connect('127.0.0.1', $Port)
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, ([Net.Security.RemoteCertificateValidationCallback] { param($sender, $cert, $chain, $errors) $true }))
    try {
      $ssl.AuthenticateAsClient('localhost')
      $request = "GET /health HTTP/1.1`r`nHost: localhost:$Port`r`nConnection: close`r`n`r`n"
      $bytes = [Text.Encoding]::ASCII.GetBytes($request)
      $ssl.Write($bytes, 0, $bytes.Length)
      $ssl.Flush()
      $reader = New-Object IO.StreamReader($ssl)
      return @{ Protocol = $ssl.SslProtocol; Response = $reader.ReadToEnd() }
    } finally { $ssl.Dispose() }
  } finally { $tcp.Dispose() }
}

function Test-PlainHttp {
  param([int]$Port)
  $tcp = New-Object Net.Sockets.TcpClient
  try {
    $tcp.Connect('127.0.0.1', $Port)
    $stream = $tcp.GetStream()
    $stream.ReadTimeout = 4000
    $request = "GET /health HTTP/1.1`r`nHost: localhost:$Port`r`nConnection: close`r`n`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($request)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $reader = New-Object IO.StreamReader($stream)
    $response = $reader.ReadToEnd()
    return ($response -match '^HTTP/1\.\d\s+200')
  } catch {
    return $false   # connection reset / no cleartext response => not serving plain HTTP
  } finally { $tcp.Dispose() }
}

try {
  # Mint the same certificate the installer uses; trust-store install is a WebView2 concern
  # and is not needed to prove the Kestrel endpoint speaks TLS rather than plain HTTP.
  $thumbprint = (& (Join-Path $PSScriptRoot '..\scripts\new-local-certificate.ps1') -PfxPath $pfx | Select-Object -Last 1).ToString().Trim()
  if (-not (Test-Path -LiteralPath $pfx)) { throw "Certificate was not created at $pfx" }

  $env:SHEET_AGENT_CERT_PATH = $pfx
  $env:SHEET_AGENT_PORT = "$Port"
  $process = Start-Process -FilePath $exe -ArgumentList '--background' -WindowStyle Hidden -PassThru

  $tls = $null
  for ($i = 0; $i -lt 40 -and -not $tls; $i++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw "Companion exited during startup with code $($process.ExitCode)" }
    try { $tls = Invoke-HealthOverTls -Port $Port } catch { $tls = $null }
  }
  if (-not $tls) { throw "https://localhost:$Port/health did not complete a TLS handshake (server may be serving plain HTTP)" }
  if ($tls.Response -notmatch '^HTTP/1\.\d\s+200') { throw "TLS handshake succeeded but /health did not return 200: $($tls.Response.Split(""`n"")[0])" }
  if ($tls.Response -notmatch '"status"\s*:\s*"ok"') { throw "/health body over TLS was unexpected: $($tls.Response)" }

  if (Test-PlainHttp -Port $Port) { throw "http://localhost:$Port/health returned 200 - port $Port is serving plain HTTP instead of HTTPS" }

  Write-Host "Companion HTTPS gate passed: /health over $($tls.Protocol) returned 200, plain HTTP refused on port $Port."
}
finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Get-Process SheetAgent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
  $env:SHEET_AGENT_CERT_PATH = $priorCertPath
  $env:SHEET_AGENT_PORT = $priorPort
  if ($thumbprint) {
    Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $thumbprint | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
}
