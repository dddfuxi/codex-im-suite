param()

$ErrorActionPreference = 'Stop'

$repoRoot = 'C:\Users\admin\Documents\New project\MCP-for-Picture'
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
    if (-not $env:MODEL_PROVIDER) {
        $env:MODEL_PROVIDER = 'codex'
    }
    node $entryFile
} finally {
    Pop-Location
}
