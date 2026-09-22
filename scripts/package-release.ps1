param(
    [switch]$NoForceUpdate
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'shared.ps1')
$suiteRoot = Split-Path -Parent $scriptDir
$defaultControlPanelDir = Join-Path $suiteRoot 'release\artifacts\control-panel'
$controlPanelDir = if ([string]::IsNullOrWhiteSpace($env:CTI_RELEASE_CONTROL_PANEL_DIR)) {
    $defaultControlPanelDir
} else {
    [System.IO.Path]::GetFullPath($env:CTI_RELEASE_CONTROL_PANEL_DIR)
}
$previousReleaseRunId = $env:CTI_RELEASE_RUN_ID
$previousControlPanelDir = $env:CTI_RELEASE_CONTROL_PANEL_DIR
if ([string]::IsNullOrWhiteSpace($env:CTI_RELEASE_RUN_ID)) {
    $env:CTI_RELEASE_RUN_ID = [guid]::NewGuid().ToString('N')
}
$env:CTI_RELEASE_CONTROL_PANEL_DIR = $controlPanelDir

try {
    & (Join-Path $scriptDir 'build-packages.ps1') -ControlPanelOutputDir $controlPanelDir -NoForceUpdate:$NoForceUpdate
    & (Join-Path $scriptDir 'sync-live-skill.ps1') -NoForceUpdate:$NoForceUpdate
    & (Join-Path $scriptDir 'assemble-portable.ps1') -ControlPanelArtifactDir $controlPanelDir -NoForceUpdate:$NoForceUpdate
    & (Join-Path $scriptDir 'build-installer.ps1') -NoForceUpdate:$NoForceUpdate
    & (Join-Path $scriptDir 'test-release-fork-health.ps1') -Mode BackupPublish -FailOnFork
    if ($LASTEXITCODE -ne 0) {
        throw "release fork health failed ($LASTEXITCODE)"
    }
}
finally {
    if ($null -eq $previousReleaseRunId) {
        Remove-Item Env:\CTI_RELEASE_RUN_ID -ErrorAction SilentlyContinue
    } else {
        $env:CTI_RELEASE_RUN_ID = $previousReleaseRunId
    }
    if ($null -eq $previousControlPanelDir) {
        Remove-Item Env:\CTI_RELEASE_CONTROL_PANEL_DIR -ErrorAction SilentlyContinue
    } else {
        $env:CTI_RELEASE_CONTROL_PANEL_DIR = $previousControlPanelDir
    }
}
