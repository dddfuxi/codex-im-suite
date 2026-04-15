$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$manifest = Get-SuiteManifest -SuiteRoot $suiteRoot

function Invoke-NpmBuild {
    param(
        [string]$Path,
        [string]$BuildScript
    )
    Write-Host "build package: $Path"
    Push-Location $Path
    try {
        npm run build | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed at $Path"
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-BridgeRuntimeBuild {
    param([string]$Path)
    Write-Host "build package: $Path (esbuild cli fallback)"
    Push-Location $Path
    try {
        if (-not (Test-Path -LiteralPath 'dist')) {
            New-Item -ItemType Directory -Force -Path 'dist' | Out-Null
        }
        npx esbuild src/main.ts `
          --bundle `
          --platform=node `
          --format=esm `
          --target=node20 `
          --outfile=dist/daemon.mjs `
          --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" `
          --external:@anthropic-ai/claude-agent-sdk `
          --external:@openai/codex-sdk `
          --external:bufferutil `
          --external:utf-8-validate `
          --external:zlib-sync `
          --external:erlpack `
          --external:fs `
          --external:path `
          --external:os `
          --external:crypto `
          --external:http `
          --external:https `
          --external:net `
          --external:tls `
          --external:stream `
          --external:events `
          --external:url `
          --external:util `
          --external:child_process `
          --external:worker_threads `
          --external:node:*
        if ($LASTEXITCODE -ne 0) {
            throw "esbuild cli failed at $Path"
        }
    }
    finally {
        Pop-Location
    }
}

$ordered = @('bridge-core', 'bridge-runtime', 'mcp-picture', 'mcp-unity-prefab')
foreach ($key in $ordered) {
    $pkg = $manifest.packages.$key
    $path = [System.IO.Path]::GetFullPath((Join-Path $suiteRoot $pkg.path))
    if ($key -eq 'bridge-runtime') {
        Invoke-BridgeRuntimeBuild -Path $path
    } else {
        Invoke-NpmBuild -Path $path -BuildScript $pkg.buildScript
    }
}

$controlPanel = Join-Path $suiteRoot 'apps\control-panel\CodexImSuite.ControlPanel.csproj'
dotnet publish $controlPanel -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o (Join-Path $suiteRoot 'release\artifacts\control-panel')
if ($LASTEXITCODE -ne 0) {
    throw "control-panel publish failed"
}
