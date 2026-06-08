param(
    [string]$Endpoint = "http://127.0.0.1:8081/mcp",
    [int]$TimeoutSeconds = 5,
    [string]$ProjectPath = $env:CTI_UNITY_PROJECT_PATH
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Invoke-McpInitialize {
    param([string]$Url, [int]$TimeoutSec)
    $body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"codex-im-suite-launcher","version":"0.0.0"}}}'
    return Invoke-WebRequest `
        -Uri $Url `
        -Method Post `
        -Headers @{ Accept = 'application/json, text/event-stream' } `
        -ContentType 'application/json' `
        -Body $body `
        -UseBasicParsing `
        -TimeoutSec $TimeoutSec
}

function Invoke-McpReadResource {
    param([string]$Url, [string]$SessionId, [string]$ResourceUri, [int]$TimeoutSec)
    $body = @{
        jsonrpc = '2.0'
        id = 2
        method = 'resources/read'
        params = @{ uri = $ResourceUri }
    } | ConvertTo-Json -Depth 10 -Compress
    return Invoke-WebRequest `
        -Uri $Url `
        -Method Post `
        -Headers @{ Accept = 'application/json, text/event-stream'; 'mcp-session-id' = $SessionId } `
        -ContentType 'application/json' `
        -Body $body `
        -UseBasicParsing `
        -TimeoutSec $TimeoutSec
}

function Test-Endpoint {
    param([string]$Url, [int]$TimeoutSec)
    try {
        $resp = Invoke-McpInitialize -Url $Url -TimeoutSec $TimeoutSec
        $sessionId = $resp.Headers['mcp-session-id']
        if (-not $sessionId) {
            throw "MCP initialize OK HTTP $($resp.StatusCode), but missing mcp-session-id"
        }

        $resourceUri = 'mcpforunity://instances'
        $resourceResp = Invoke-McpReadResource -Url $Url -SessionId $sessionId -ResourceUri $resourceUri -TimeoutSec $TimeoutSec
        $content = [string]$resourceResp.Content
        $countMatch = [regex]::Match($content, '\\?"instance_count\\?"\s*:\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($countMatch.Success) {
            $instanceCount = [int]$countMatch.Groups[1].Value
            if ($instanceCount -gt 0) {
                return "MCP initialize OK HTTP $($resp.StatusCode); Unity instances OK count=$instanceCount"
            }
            throw "MCP protocol OK but Unity Editor session is not connected (instance_count=0)"
        }
        if ($content -match '[A-Za-z0-9_\- .]+@[a-fA-F0-9]{4,}') {
            return "MCP initialize OK HTTP $($resp.StatusCode); Unity instance visible"
        }
        throw "MCP protocol OK but Unity instances response is not recognizable: $($content.Substring(0, [Math]::Min(240, $content.Length)))"
    }
    catch {
        if ($_.Exception.Response) {
            throw "HTTP $([int]$_.Exception.Response.StatusCode)"
        }
        throw
    }
}

function Wait-UnityMcpEndpoint {
    param([string]$Url, [int]$TimeoutSec, [int]$Attempts = 8)
    $lastError = $null
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            return Test-Endpoint -Url $Url -TimeoutSec $TimeoutSec
        } catch {
            $lastError = $_.Exception.Message
            Write-Host "Waiting Unity MCP endpoint ($i/$Attempts): $lastError"
            Start-Sleep -Seconds 2
        }
    }
    throw "Unity MCP endpoint did not become ready after repair: $lastError"
}

function Stop-UnityMcpHelper {
    $patterns = @(
        'mcp-for-unity',
        'mcpforunityserver'
    )
    $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = [string]$_.CommandLine
            if (-not $cmd) { return $false }
            foreach ($pattern in $patterns) {
                if ($cmd -match [regex]::Escape($pattern)) { return $true }
            }
            return $false
        }
    foreach ($proc in $targets) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped Unity MCP helper PID=$($proc.ProcessId)"
        } catch {
            Write-Warning "Failed to stop Unity MCP helper PID=$($proc.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Start-UnityMcpHelper {
    param([string]$Project)
    if ([string]::IsNullOrWhiteSpace($Project)) {
        $current = (Get-Location).Path
        if (Test-Path -LiteralPath (Join-Path $current 'ProjectSettings\ProjectVersion.txt')) {
            $Project = $current
        } else {
            throw "Unity project path is not configured. Set CTI_UNITY_PROJECT_PATH or run this launcher from a Unity project root."
        }
    }
    $terminalScript = Join-Path $Project 'Library\MCPForUnity\TerminalScripts\mcp-terminal.cmd'
    $autostartRequest = Join-Path $Project 'Library\MCPForUnity\http-autostart.request'
    if (Test-Path -LiteralPath $terminalScript) {
        Start-Process -FilePath $terminalScript -WorkingDirectory (Split-Path -Parent $terminalScript) -WindowStyle Hidden
        Write-Host "Started Unity MCP helper from $terminalScript"
        return
    }
    if (Test-Path -LiteralPath (Split-Path -Parent $autostartRequest)) {
        Set-Content -LiteralPath $autostartRequest -Value 'start' -Encoding UTF8
        Write-Host "Requested Unity MCP HTTP autostart: $autostartRequest"
        return
    }
    throw "Unity MCP terminal script not found. Open Unity project and enable MCPForUnity HTTP server once."
}

$before = $null
try {
    $before = Test-Endpoint -Url $Endpoint -TimeoutSec $TimeoutSeconds
    Write-Host "Unity MCP before repair: $Endpoint $before"
} catch {
    Write-Host "Unity MCP before repair: $Endpoint unavailable | $($_.Exception.Message)"
}

Stop-UnityMcpHelper
Start-Sleep -Seconds 1
Start-UnityMcpHelper -Project $ProjectPath
Start-Sleep -Seconds 2

$after = Wait-UnityMcpEndpoint -Url $Endpoint -TimeoutSec $TimeoutSeconds
Write-Host "Unity MCP after repair: $Endpoint $after"
