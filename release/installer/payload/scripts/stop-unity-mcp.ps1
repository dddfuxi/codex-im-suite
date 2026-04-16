$ErrorActionPreference = 'Stop'

$patterns = @(
    'mcp-for-unity',
    'mcpforunityserver'
)

$killed = 0
$targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $cmd = [string]$_.CommandLine
        if (-not $cmd) { return $false }
        foreach ($pattern in $patterns) {
            if ($cmd -match [regex]::Escape($pattern)) {
                return $true
            }
        }
        return $false
    }

foreach ($proc in $targets) {
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Write-Host "Stopped unity MCP helper PID=$($proc.ProcessId)"
        $killed++
    } catch {
        Write-Warning "Failed to stop PID=$($proc.ProcessId): $($_.Exception.Message)"
    }
}

if ($killed -eq 0) {
    Write-Host "No running unity MCP helper process found."
}
