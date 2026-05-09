param(
    [switch]$NoForceUpdate
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$portableDir = Join-Path $suiteRoot 'release\portable'
$installerDir = Join-Path $suiteRoot 'release\installer'
$project = Join-Path $suiteRoot 'apps\installer\CodexImSuite.Installer.csproj'

Clear-RunningProcessInPathForUpdate -Roots @($installerDir) -Purpose 'build installer' -NoForceUpdate:$NoForceUpdate
if (Test-Path -LiteralPath $installerDir) {
    Remove-PathForUpdate -Path $installerDir -Purpose 'build installer cleanup'
}
New-Item -ItemType Directory -Force -Path (Join-Path $installerDir 'payload') | Out-Null
Copy-Item -Path (Join-Path $portableDir '*') -Destination (Join-Path $installerDir 'payload') -Recurse -Force

$payloadDir = Join-Path $installerDir 'payload'
$content = Get-SuiteReleaseActualContentMap -SuiteRoot $suiteRoot -TargetRoot $payloadDir -Layout 'InstallerPayload'
$fingerprint = New-SuiteReleaseFingerprint `
    -SuiteRoot $suiteRoot `
    -TargetName 'installer payload' `
    -TargetRole 'generated installer payload' `
    -ReleaseRunId $env:CTI_RELEASE_RUN_ID `
    -Content $content `
    -ManifestSummary (Get-ReleaseManifestSummary -Root $payloadDir) `
    -PanelSummary (Get-ReleasePanelSummary -Path (Join-Path $payloadDir 'CodexImSuiteControlPanel.exe'))
Write-SuiteReleaseFingerprint -TargetRoot $payloadDir -Fingerprint $fingerprint | Out-Null

dotnet publish $project -c Release -r win-x64 --self-contained false -p:PublishSingleFile=false -o $installerDir
if ($LASTEXITCODE -ne 0) {
    throw "installer publish failed"
}
Write-Host "installer built: $installerDir"
