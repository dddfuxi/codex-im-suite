$ErrorActionPreference = 'Stop'
$repoRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'packages\mcp-picture'
$repoRoot = [System.IO.Path]::GetFullPath($repoRoot)
$entryFile = Join-Path $repoRoot 'dist\src\mcp-stdio.js'

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath $entryFile)) {
        npm run build | Out-Host
    }
    if (-not $env:MODEL_PROVIDER) {
        $env:MODEL_PROVIDER = 'codex'
    }
    node $entryFile
}
finally {
    Pop-Location
}
