param(
    [string]$Endpoint = "http://127.0.0.1:8081/mcp",
    [int]$TimeoutSeconds = 3
)

$ErrorActionPreference = 'Stop'

function Test-Endpoint {
    param([string]$Url, [int]$TimeoutSec)
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method Get -UseBasicParsing -TimeoutSec $TimeoutSec
        return "HTTP $($resp.StatusCode)"
    }
    catch {
        if ($_.Exception.Response) {
            return "HTTP $([int]$_.Exception.Response.StatusCode)"
        }
        throw
    }
}

$result = Test-Endpoint -Url $Endpoint -TimeoutSec $TimeoutSeconds
Write-Host "Unity MCP reachable: $Endpoint $result"
