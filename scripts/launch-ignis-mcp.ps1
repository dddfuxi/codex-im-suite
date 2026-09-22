$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$repoRoot = Join-Path $suiteRoot 'packages\mcp-ignis'
$entryFile = Join-Path $repoRoot 'dist\src\http-server.js'
$runtimeDir = Join-Path $env:USERPROFILE '.claude-to-im\runtime'
$pidFile = Join-Path $runtimeDir 'ignis-mcp.pid'
$port = if ($env:IGNIS_MCP_PORT) { [int]$env:IGNIS_MCP_PORT } else { 8787 }
$healthUrl = "http://127.0.0.1:$port/mcp"

function Test-IgnisMcpOnline {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    } catch {
        return $false
    }
}

if (Test-IgnisMcpOnline) {
    Write-Host "Ignis MCP already online: $healthUrl"
    exit 0
}

if (-not (Get-Command ignis -ErrorAction SilentlyContinue)) {
    throw "ignis CLI missing. Install with: npm install -g ignis-agent-cli"
}

$ignisConfig = Join-Path $env:USERPROFILE '.ignis\config.json'
if (-not (Test-Path -LiteralPath $ignisConfig)) {
    throw "Ignis config missing: $ignisConfig"
}

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath 'node_modules')) {
        npm install | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm install failed at $repoRoot" }
    }
    if (-not (Test-Path -LiteralPath $entryFile)) {
        npm run build | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed at $repoRoot" }
    }

    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    $env:CODEX_IM_SUITE_ROOT = $suiteRoot
    $env:IGNIS_MCP_PORT = [string]$port
    $node = (Get-Command node -ErrorAction Stop).Source
    $process = Start-Process -FilePath $node -ArgumentList ('"' + $entryFile + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $pidFile -Encoding ASCII -Value ([string]$process.Id)

    Start-Sleep -Milliseconds 1200
    if (-not (Test-IgnisMcpOnline)) {
        throw "Ignis MCP failed to become healthy at $healthUrl"
    }
    Write-Host "Ignis MCP started: PID=$($process.Id) URL=$healthUrl"
}
finally {
    Pop-Location
}
