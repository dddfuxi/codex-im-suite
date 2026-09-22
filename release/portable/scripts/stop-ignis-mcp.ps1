$ErrorActionPreference = 'Stop'

$runtimeDir = Join-Path $env:USERPROFILE '.claude-to-im\runtime'
$pidFile = Join-Path $runtimeDir 'ignis-mcp.pid'
$port = if ($env:IGNIS_MCP_PORT) { [int]$env:IGNIS_MCP_PORT } else { 8787 }
$stopped = $false

if (Test-Path -LiteralPath $pidFile) {
    $raw = (Get-Content -Raw -Encoding ASCII -LiteralPath $pidFile).Trim()
    if ($raw -match '^\d+$') {
        $pidValue = [int]$raw
        try {
            Stop-Process -Id $pidValue -Force -ErrorAction Stop
            Write-Host "Stopped Ignis MCP PID=$pidValue"
            $stopped = $true
        } catch {
            Write-Warning "Ignis MCP PID was not running: $pidValue"
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

try {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -gt 0) {
            Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped Ignis MCP listener PID=$($listener.OwningProcess)"
            $stopped = $true
        }
    }
} catch {
    Write-Warning "Port cleanup skipped: $($_.Exception.Message)"
}

if (-not $stopped) {
    Write-Host "Ignis MCP was not running."
}
