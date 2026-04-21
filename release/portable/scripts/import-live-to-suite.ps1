param(
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)

$liveCore = Join-Path $userHome '.codex\skills\claude-to-im-core'
$liveRuntime = Join-Path $userHome '.codex\skills\claude-to-im'

$suiteCore = Join-Path $suiteRoot 'packages\bridge-core'
$suiteRuntime = Join-Path $suiteRoot 'packages\bridge-runtime'
$suiteControlPanel = Join-Path $suiteRoot 'apps\control-panel'

function Copy-PathContent {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Source not found: $Source"
    }

    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    robocopy $Source $Target /MIR /XD node_modules dist bin obj .git coverage .turbo .next release /XF "*.tmp" | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed ($code): $Source -> $Target"
    }
}

function Import-Directory {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        Write-Warning "Skip missing source: $Source"
        return
    }

    if ($Apply) {
        Copy-PathContent -Source $Source -Target $Target
    } else {
        Write-Host "[dry-run] would import $Source -> $Target"
    }
}

function Import-File {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        return
    }

    if ($Apply) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Target -Force
    } else {
        Write-Host "[dry-run] would import $Source -> $Target"
    }
}

if (-not $Apply) {
    Write-Host "Dry run only. Re-run with -Apply to import live skill files into the suite."
    Write-Host "This script is for emergency recovery only; normal maintenance direction is suite -> live."
}

Import-Directory -Source (Join-Path $liveCore 'src') -Target (Join-Path $suiteCore 'src')
Import-Directory -Source (Join-Path $liveRuntime 'src') -Target (Join-Path $suiteRuntime 'src')
Import-Directory -Source (Join-Path $liveRuntime 'scripts') -Target (Join-Path $suiteRuntime 'scripts')
Import-Directory -Source (Join-Path $liveRuntime 'mcp.d') -Target (Join-Path $suiteRuntime 'mcp.d')

$runtimeFiles = @(
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'README.md',
    'README_CN.md',
    'SKILL.md',
    'AGENTS.md',
    'CLAUDE.md',
    'AI-MAINTENANCE.md',
    'SECURITY.md',
    'config.env.example',
    'LICENSE'
)

foreach ($name in $runtimeFiles) {
    Import-File -Source (Join-Path $liveRuntime $name) -Target (Join-Path $suiteRuntime $name)
}

$coreFiles = @(
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'README.md',
    'LICENSE'
)

foreach ($name in $coreFiles) {
    Import-File -Source (Join-Path $liveCore $name) -Target (Join-Path $suiteCore $name)
}

if ($Apply) {
    Write-Host "import complete: live skills -> suite"
}
