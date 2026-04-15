param()

$ErrorActionPreference = 'Stop'

$repoRoot = 'C:\Users\admin\Documents\New project\MCP-for-Unity-Prefab'
$entryFile = Join-Path $repoRoot 'dist\src\mcp-stdio.js'
$sourceDir = Join-Path $repoRoot 'src'

function Get-LatestSourceWriteTime {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return [datetime]::MinValue }
    $latest = Get-ChildItem -Path $Path -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { return [datetime]::MinValue }
    return $latest.LastWriteTime
}

function Ensure-Built {
    $needsBuild = -not (Test-Path $entryFile)
    if (-not $needsBuild) {
        $sourceTime = Get-LatestSourceWriteTime -Path $sourceDir
        $entryTime = (Get-Item $entryFile).LastWriteTime
        $needsBuild = $sourceTime -gt $entryTime
    }

    if ($needsBuild) {
        Push-Location $repoRoot
        try {
            npm run build | Out-Host
        } finally {
            Pop-Location
        }
    }
}

Ensure-Built

Push-Location $repoRoot
try {
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
} finally {
    Pop-Location
}
