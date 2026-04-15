$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
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

Write-Host "sync live bridge-core -> suite"
Copy-PathContent -Source (Join-Path $liveCore 'src') -Target (Join-Path $suiteCore 'src')

Write-Host "sync live bridge-runtime -> suite"
Copy-PathContent -Source (Join-Path $liveRuntime 'src') -Target (Join-Path $suiteRuntime 'src')
Copy-PathContent -Source (Join-Path $liveRuntime 'scripts') -Target (Join-Path $suiteRuntime 'scripts')
Copy-PathContent -Source (Join-Path $liveRuntime 'mcp.d') -Target (Join-Path $suiteRuntime 'mcp.d')

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
    $source = Join-Path $liveRuntime $name
    $target = Join-Path $suiteRuntime $name
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
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
    $source = Join-Path $liveCore $name
    $target = Join-Path $suiteCore $name
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

$liveControlPanelProgram = Join-Path $liveRuntime 'tools\ControlPanel\Program.cs'
$suiteControlPanelProgram = Join-Path $suiteControlPanel 'Program.cs'
if (Test-Path -LiteralPath $liveControlPanelProgram) {
    Copy-Item -LiteralPath $liveControlPanelProgram -Destination $suiteControlPanelProgram -Force
}

Write-Host "sync complete"
