$ErrorActionPreference = 'Stop'

$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$pidFile = Join-Path (Join-Path $ctiHome 'runtime') 'local-llm-server.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'not running'
    exit 0
}

$serverPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $serverPid) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output 'not running'
    exit 0
}

$proc = Get-Process -Id ([int]$serverPid) -ErrorAction SilentlyContinue
if ($proc) {
    Stop-Process -Id $proc.Id -Force
    Write-Output "stopped: PID=$serverPid"
} else {
    Write-Output "stale pid removed: PID=$serverPid"
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
