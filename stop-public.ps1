$ErrorActionPreference = "Stop"

$processFile = Join-Path $env:LOCALAPPDATA "InspectionAI\public-tunnel-processes.json"
if (-not (Test-Path -LiteralPath $processFile)) {
  throw "Tunnel process file not found: $processFile"
}

$state = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
foreach ($entry in @(
  @{ Id = [int]$state.tunnelPid; StartedAt = [long]$state.tunnelStartedAt; Name = "cloudflared" },
  @{ Id = [int]$state.nodePid; StartedAt = [long]$state.nodeStartedAt; Name = "node" }
)) {
  $process = Get-Process -Id $entry.Id -ErrorAction SilentlyContinue
  if (-not $process) { continue }
  if ($process.ProcessName -ne $entry.Name -or $process.StartTime.ToUniversalTime().Ticks -ne $entry.StartedAt) {
    throw "PID $($entry.Id) no longer matches the tunnel process; stopping was cancelled."
  }
  Stop-Process -Id $entry.Id -Force
}

Remove-Item -LiteralPath $processFile -Force
Write-Output "Stopped the public tunnel processes for $($state.url)."
