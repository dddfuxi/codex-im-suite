$ErrorActionPreference = 'Stop'

$killed = 0
$targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -match '^(python|uvx|uv|powershell|cmd)(\.exe)?$' -and
        $_.CommandLine -and
        $_.CommandLine -match 'blender-mcp'
    }

foreach ($proc in $targets) {
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Write-Host "Stopped blender MCP process PID=$($proc.ProcessId)"
        $killed++
    } catch {
        Write-Warning "Failed to stop PID=$($proc.ProcessId): $($_.Exception.Message)"
    }
}

if ($killed -eq 0) {
    Write-Host "No running blender MCP process found."
}
