$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$controlPanelArtifactDir = Join-Path $suiteRoot 'release\artifacts\control-panel-main'
$previousReleaseRunId = $env:CTI_RELEASE_RUN_ID
$previousControlPanelDir = $env:CTI_RELEASE_CONTROL_PANEL_DIR
if ([string]::IsNullOrWhiteSpace($env:CTI_RELEASE_RUN_ID)) {
    $env:CTI_RELEASE_RUN_ID = [guid]::NewGuid().ToString('N')
}
$env:CTI_RELEASE_CONTROL_PANEL_DIR = $controlPanelArtifactDir

try {
    & (Join-Path $scriptDir 'validate-extension-manifests.ps1')
    & (Join-Path $scriptDir 'build-packages.ps1') -ControlPanelOutputDir $controlPanelArtifactDir
    & (Join-Path $scriptDir 'assemble-portable.ps1') -ControlPanelArtifactDir $controlPanelArtifactDir
    & (Join-Path $scriptDir 'build-installer.ps1')
    & (Join-Path $scriptDir 'test-release-fork-health.ps1') -Mode MainPreflight -FailOnFork
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

Write-Host "main release package built without live skill sync"
