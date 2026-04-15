$ErrorActionPreference = 'Stop'
$repoRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'packages\mcp-unity-prefab'
$repoRoot = [System.IO.Path]::GetFullPath($repoRoot)
$entryFile = Join-Path $repoRoot 'dist\src\mcp-stdio.js'

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath $entryFile)) {
        npm run build | Out-Host
    }
    if (-not $env:UNITY_MCP_HOST) {
        $env:UNITY_MCP_HOST = '127.0.0.1'
    }
    if (-not $env:UNITY_MCP_HTTP_PORT) {
        $env:UNITY_MCP_HTTP_PORT = '8081'
    }
    if (-not $env:UNITY_MCP_TIMEOUT_MS) {
        $env:UNITY_MCP_TIMEOUT_MS = '30000'
    }
    node $entryFile
}
finally {
    Pop-Location
}
