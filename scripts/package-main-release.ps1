$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$controlPanelArtifactDir = Join-Path $suiteRoot 'release\artifacts\control-panel-main'

& (Join-Path $scriptDir 'validate-extension-manifests.ps1')
& (Join-Path $scriptDir 'build-packages.ps1') -ControlPanelOutputDir $controlPanelArtifactDir
& (Join-Path $scriptDir 'assemble-portable.ps1') -ControlPanelArtifactDir $controlPanelArtifactDir
& (Join-Path $scriptDir 'build-installer.ps1')

Write-Host "main release package built without live skill sync"
