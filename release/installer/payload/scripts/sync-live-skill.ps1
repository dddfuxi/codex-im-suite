$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)

$liveCore = Join-Path $userHome '.codex\skills\claude-to-im-core'
$liveRuntime = Join-Path $userHome '.codex\skills\claude-to-im'

$suiteCore = Join-Path $suiteRoot 'packages\bridge-core'
$suiteRuntime = Join-Path $suiteRoot 'packages\bridge-runtime'
$suiteControlPanel = Join-Path $suiteRoot 'apps\control-panel'
$portableDir = Join-Path $suiteRoot 'release\portable'

Assert-NoRunningProcessInPath -Roots @($liveRuntime, $liveCore, $portableDir) -Purpose 'sync live skill'

function Copy-PathContent {
    param(
        [string]$Source,
        [string]$Target,
        [string[]]$ExcludeDirectories = @('node_modules', 'bin', 'obj', '.git', 'coverage', '.turbo', '.next', 'release'),
        [string[]]$ExcludeFiles = @('*.tmp')
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Source not found: $Source"
    }

    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    $args = @($Source, $Target, '/MIR')
    if ($ExcludeDirectories.Count -gt 0) {
        $args += '/XD'
        $args += $ExcludeDirectories
    }
    if ($ExcludeFiles.Count -gt 0) {
        $args += '/XF'
        $args += $ExcludeFiles
    }

    robocopy @args | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed ($code): $Source -> $Target"
    }
}

function Copy-ExistingFile {
    param(
        [string]$Source,
        [string]$Target
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        return
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Target -Force
}

function Copy-ExistingDirectory {
    param(
        [string]$Source,
        [string]$Target
    )

    if (Test-Path -LiteralPath $Source) {
        Copy-PathContent -Source $Source -Target $Target
    }
}

Write-Host "sync suite bridge-core -> live skill"
Copy-ExistingDirectory -Source (Join-Path $suiteCore 'src') -Target (Join-Path $liveCore 'src')
Copy-ExistingDirectory -Source (Join-Path $suiteCore 'dist') -Target (Join-Path $liveCore 'dist')

$coreFiles = @(
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'README.md',
    'README.zh-CN.md',
    'LICENSE'
)

foreach ($name in $coreFiles) {
    Copy-ExistingFile -Source (Join-Path $suiteCore $name) -Target (Join-Path $liveCore $name)
}

Write-Host "sync suite bridge-runtime -> live skill"
Copy-ExistingDirectory -Source (Join-Path $suiteRuntime 'src') -Target (Join-Path $liveRuntime 'src')
Copy-ExistingDirectory -Source (Join-Path $suiteRuntime 'scripts') -Target (Join-Path $liveRuntime 'scripts')
Copy-ExistingDirectory -Source (Join-Path $suiteRuntime 'mcp.d') -Target (Join-Path $liveRuntime 'mcp.d')
Copy-ExistingDirectory -Source (Join-Path $suiteRuntime 'docs') -Target (Join-Path $liveRuntime 'docs')
Copy-ExistingDirectory -Source (Join-Path $suiteRuntime 'references') -Target (Join-Path $liveRuntime 'references')
Copy-ExistingDirectory -Source (Join-Path $suiteRuntime 'evals') -Target (Join-Path $liveRuntime 'evals')
Copy-ExistingDirectory -Source (Join-Path $suiteRuntime 'dist') -Target (Join-Path $liveRuntime 'dist')

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
    Copy-ExistingFile -Source (Join-Path $suiteRuntime $name) -Target (Join-Path $liveRuntime $name)
}

Copy-ExistingFile -Source (Join-Path $suiteRoot 'scripts\export-glb-asset-package.ps1') -Target (Join-Path $liveRuntime 'scripts\export-glb-asset-package.ps1')
Copy-ExistingFile -Source (Join-Path $suiteRoot 'scripts\export-glb-asset-package.py') -Target (Join-Path $liveRuntime 'scripts\export-glb-asset-package.py')

Write-Host "remove live legacy tools mirror"
$liveToolsDir = Join-Path $liveRuntime 'tools'
if (Test-Path -LiteralPath $liveToolsDir) {
    Remove-Item -LiteralPath $liveToolsDir -Recurse -Force
}

$builtPanelDir = if ($env:CTI_RELEASE_CONTROL_PANEL_DIR) {
    $env:CTI_RELEASE_CONTROL_PANEL_DIR
} else {
    Join-Path $suiteRoot 'release\artifacts\control-panel'
}
$builtPanelExe = Join-Path $builtPanelDir 'CodexImSuiteControlPanel.exe'
$builtPanelPdb = Join-Path $builtPanelDir 'CodexImSuiteControlPanel.pdb'
$livePanelDir = Join-Path $liveRuntime 'dist\control-panel'
Copy-ExistingDirectory -Source $builtPanelDir -Target $livePanelDir
Copy-ExistingFile -Source $builtPanelExe -Target (Join-Path $livePanelDir 'CodexImSuiteControlPanel.exe')
Copy-ExistingFile -Source $builtPanelExe -Target (Join-Path $livePanelDir 'ClaudeToImControlPanel.exe')
Copy-ExistingFile -Source $builtPanelPdb -Target (Join-Path $livePanelDir 'CodexImSuiteControlPanel.pdb')
Copy-ExistingFile -Source $builtPanelPdb -Target (Join-Path $livePanelDir 'ClaudeToImControlPanel.pdb')

$runtimeContent = Get-SuiteReleaseActualContentMap -SuiteRoot $suiteRoot -TargetRoot $liveRuntime -Layout 'LiveRuntime'
$runtimeFingerprint = New-SuiteReleaseFingerprint `
    -SuiteRoot $suiteRoot `
    -TargetName 'live runtime skill' `
    -TargetRole 'runtime copy generated from suite' `
    -ReleaseRunId $env:CTI_RELEASE_RUN_ID `
    -Content $runtimeContent `
    -ManifestSummary (Get-ReleaseManifestSummary -Root $liveRuntime) `
    -PanelSummary (Get-ReleasePanelSummary -Path (Join-Path $livePanelDir 'ClaudeToImControlPanel.exe'))
Write-SuiteReleaseFingerprint -TargetRoot $liveRuntime -Fingerprint $runtimeFingerprint | Out-Null

$coreContent = Get-SuiteReleaseActualContentMap -SuiteRoot $suiteRoot -TargetRoot $liveCore -Layout 'LiveCore'
$coreFingerprint = New-SuiteReleaseFingerprint `
    -SuiteRoot $suiteRoot `
    -TargetName 'live core skill' `
    -TargetRole 'runtime copy generated from suite' `
    -ReleaseRunId $env:CTI_RELEASE_RUN_ID `
    -Content $coreContent `
    -ManifestSummary (Get-ReleaseManifestSummary -Root $liveCore) `
    -PanelSummary (Get-ReleasePanelSummary -Path (Join-Path $liveCore 'dist\control-panel\ClaudeToImControlPanel.exe'))
Write-SuiteReleaseFingerprint -TargetRoot $liveCore -Fingerprint $coreFingerprint | Out-Null

Write-Host "sync complete: suite -> live skills"
