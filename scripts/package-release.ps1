$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'shared.ps1')
$suiteRoot = Split-Path -Parent $scriptDir
$defaultControlPanelDir = Join-Path $suiteRoot 'release\artifacts\control-panel'
$publishControlPanelDir = Join-Path $suiteRoot 'release\artifacts\control-panel-publish'
$controlPanelDir = $defaultControlPanelDir
$previousReleaseRunId = $env:CTI_RELEASE_RUN_ID
$previousControlPanelDir = $env:CTI_RELEASE_CONTROL_PANEL_DIR
if ([string]::IsNullOrWhiteSpace($env:CTI_RELEASE_RUN_ID)) {
    $env:CTI_RELEASE_RUN_ID = [guid]::NewGuid().ToString('N')
}

$runningDefaultPanel = @(Find-RunningProcessInPath -Roots @($defaultControlPanelDir))
if ($runningDefaultPanel.Count -gt 0) {
    $controlPanelDir = $publishControlPanelDir
    Write-Host "control panel artifact is running; build output redirected to: $controlPanelDir"
    foreach ($process in $runningDefaultPanel) {
        Write-Host ("  running panel PID {0} | {1}" -f $process.Id, $process.Path)
    }
}
$env:CTI_RELEASE_CONTROL_PANEL_DIR = $controlPanelDir

try {
    & (Join-Path $scriptDir 'build-packages.ps1') -ControlPanelOutputDir $controlPanelDir
    & (Join-Path $scriptDir 'sync-live-skill.ps1')
    & (Join-Path $scriptDir 'assemble-portable.ps1') -ControlPanelArtifactDir $controlPanelDir
    & (Join-Path $scriptDir 'build-installer.ps1')
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
