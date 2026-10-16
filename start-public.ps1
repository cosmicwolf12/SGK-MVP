$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  $cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
}
if (-not $cloudflared) {
  $installedPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if (Test-Path -LiteralPath $installedPath) {
    $cloudflared = Get-Item -LiteralPath $installedPath
  } else {
    throw "cloudflared is not installed. Install Cloudflare Tunnel and retry."
  }
}
$cloudflaredPath = if ($cloudflared -is [System.IO.FileInfo]) { $cloudflared.FullName } else { $cloudflared.Source }

$port = 5000
$dataDirectory = Join-Path $projectRoot "inspection_data"
$logDirectory = Join-Path $env:LOCALAPPDATA "InspectionAI"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  $owners = ($listeners | ForEach-Object { "PID $($_.OwningProcess)" }) -join ", "
  throw "Port $port is already in use ($owners). Stop the existing server and retry."
}

$processFile = Join-Path $logDirectory "public-tunnel-processes.json"
if (Test-Path -LiteralPath $processFile) {
  throw "A previous tunnel session is recorded. Run stop-public.ps1 before starting again."
}
foreach ($logName in @("node-public.log", "node-public-error.log", "cloudflared.log", "cloudflared-error.log")) {
  $logPath = Join-Path $logDirectory $logName
  if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force }
}

$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$randomBytes = New-Object byte[] 24
$rng.GetBytes($randomBytes)
$rng.Dispose()
$password = [Convert]::ToBase64String($randomBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$username = "inspection"

$env:PORT = "$port"
$env:INSPECTION_DATA_DIR = $dataDirectory
$env:PUBLIC_ACCESS = "1"
$env:APP_USERNAME = $username
$env:APP_PASSWORD = $password
$tunnel = $null
$node = Start-Process -FilePath (Get-Command node.exe).Source `
  -ArgumentList "server.js" -WorkingDirectory $projectRoot -PassThru `
  -RedirectStandardOutput (Join-Path $logDirectory "node-public.log") `
  -RedirectStandardError (Join-Path $logDirectory "node-public-error.log")

try {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    if ($node.HasExited) {
      throw "Node.js exited during startup. See $logDirectory\node-public-error.log"
    }
    $httpStatus = & curl.exe --silent --output NUL --max-time 2 --write-out "%{http_code}" "http://127.0.0.1:$port/"
    if ($LASTEXITCODE -eq 0 -and $httpStatus -in @("200", "401")) { break }
  } while ((Get-Date) -lt $deadline)

  if ((Get-Date) -ge $deadline) {
    throw "Node.js did not respond on localhost:$port within 20 seconds."
  }

  $tunnel = Start-Process -FilePath $cloudflaredPath `
    -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$port") `
    -PassThru -RedirectStandardOutput (Join-Path $logDirectory "cloudflared.log") `
    -RedirectStandardError (Join-Path $logDirectory "cloudflared-error.log")

  $tunnelLog = Join-Path $logDirectory "cloudflared.log"
  $errorLog = Join-Path $logDirectory "cloudflared-error.log"
  $deadline = (Get-Date).AddSeconds(60)
  $publicUrl = $null
  $tunnelConnected = $false
  do {
    Start-Sleep -Seconds 1
    if ($tunnel.HasExited) {
      $details = if (Test-Path $errorLog) { Get-Content $errorLog -Raw } else { "see logs in $logDirectory" }
      throw "cloudflared exited with code $($tunnel.ExitCode): $details"
    }
    if ((Test-Path $tunnelLog) -or (Test-Path $errorLog)) {
      $log = "$(if (Test-Path $tunnelLog) { Get-Content $tunnelLog -Raw })`n$(if (Test-Path $errorLog) { Get-Content $errorLog -Raw })"
      if ($log -match "https://[a-z0-9-]+\.trycloudflare\.com") {
        $publicUrl = $Matches[0]
      }
      if ($log -match "Registered tunnel connection") {
        $tunnelConnected = $true
      }
      if ($log -match "precheck complete hard_fail=true") {
        throw "Cloudflare cannot connect from this network. Permit outbound TCP/UDP port 7844, then retry."
      }
    }
  } while ((-not $publicUrl -or -not $tunnelConnected) -and (Get-Date) -lt $deadline)

  if (-not $publicUrl -or -not $tunnelConnected) {
    throw "Cloudflare did not establish a tunnel within 60 seconds. See logs in $logDirectory"
  }

  @{
    nodePid = $node.Id
    nodeStartedAt = (Get-Process -Id $node.Id).StartTime.ToUniversalTime().Ticks
    tunnelPid = $tunnel.Id
    tunnelStartedAt = (Get-Process -Id $tunnel.Id).StartTime.ToUniversalTime().Ticks
    url = $publicUrl
  } | ConvertTo-Json | Set-Content -LiteralPath $processFile -Encoding ASCII

  Write-Output "Public HTTPS URL: $publicUrl"
  Write-Output "Username: $username"
  Write-Output "Password: $password"
  Write-Output "Node PID: $($node.Id); cloudflared PID: $($tunnel.Id)"
  Write-Output "The website and tunnel will stay online until these processes are stopped."
} catch {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  if (-not $node.HasExited) { Stop-Process -Id $node.Id -Force }
  throw
}
