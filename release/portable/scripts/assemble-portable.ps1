param(
    [string]$ControlPanelArtifactDir,
    [switch]$NoForceUpdate
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$portableDir = Join-Path $suiteRoot 'release\portable'
$artifactsDir = Join-Path $suiteRoot 'release\artifacts'
$manifest = Get-SuiteManifest -SuiteRoot $suiteRoot
if (-not $ControlPanelArtifactDir) {
    $ControlPanelArtifactDir = Join-Path $artifactsDir 'control-panel'
}
$ControlPanelArtifactDir = [System.IO.Path]::GetFullPath($ControlPanelArtifactDir)
$controlPanelExecutable = Join-Path $ControlPanelArtifactDir 'CodexImSuiteControlPanel.exe'
$controlPanelWebRoot = Join-Path $ControlPanelArtifactDir 'wwwroot\index.html'
if (-not (Test-Path -LiteralPath $controlPanelExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $controlPanelWebRoot -PathType Leaf)) {
    throw "Control panel artifact is incomplete: $ControlPanelArtifactDir"
}

function Remove-FileWithRetry {
    param(
        [string]$Path,
        [int]$Retries = 8
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }

    for ($i = 0; $i -lt $Retries; $i++) {
        try {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
            return
        }
        catch {
            if ($i -eq ($Retries - 1)) {
                throw
            }
            Start-Sleep -Milliseconds (250 * ($i + 1))
        }
    }
}

Clear-RunningProcessInPathForUpdate -Roots @($portableDir) -Purpose 'assemble portable' -NoForceUpdate:$NoForceUpdate
if (Test-Path -LiteralPath $portableDir) {
    Remove-PathForUpdate -Path $portableDir -Purpose 'assemble portable cleanup'
}
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null

# Exclude WebView2 user-data directories because they contain locked runtime state.
# Copy every top-level artifact to an explicit same-name target so PowerShell host
# differences cannot flatten a directory or omit the formal release entry point.
$controlPanelArtifacts = @(Get-ChildItem -LiteralPath $ControlPanelArtifactDir -Force |
    Where-Object { $_.Name -notlike '*.pdb' -and $_.Name -notlike '*.WebView2' })
foreach ($artifact in $controlPanelArtifacts) {
    $artifactTarget = Join-Path $portableDir $artifact.Name
    Copy-Item -LiteralPath $artifact.FullName -Destination $artifactTarget -Recurse -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $portableDir 'CodexImSuiteControlPanel.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $portableDir 'wwwroot\index.html') -PathType Leaf)) {
    throw "Portable control panel copy is incomplete: $portableDir"
}
Copy-Item -LiteralPath (Join-Path $suiteRoot 'suite.manifest.json') -Destination $portableDir -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'README.md') -Destination $portableDir -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'AGENTS.md') -Destination $portableDir -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'docs') -Destination (Join-Path $portableDir 'docs') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'config') -Destination (Join-Path $portableDir 'config') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'extensions') -Destination (Join-Path $portableDir 'extensions') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'scripts') -Destination (Join-Path $portableDir 'scripts') -Recurse -Force

$packagesDir = Join-Path $portableDir 'packages'
New-Item -ItemType Directory -Force -Path $packagesDir | Out-Null

foreach ($pkgName in $manifest.packages.PSObject.Properties.Name) {
    $pkg = $manifest.packages.$pkgName
    $src = [System.IO.Path]::GetFullPath((Join-Path $suiteRoot $pkg.path))
    $dst = Join-Path $packagesDir $pkgName
    New-Item -ItemType Directory -Force -Path $dst | Out-Null

    foreach ($name in @('dist', 'scripts', 'config.env.example', 'package.json', 'package-lock.json', 'README.md', 'README_CN.md', 'README.zh-CN.md', 'SKILL.md')) {
        $item = Join-Path $src $name
        if (Test-Path -LiteralPath $item) {
            Copy-Item -LiteralPath $item -Destination $dst -Recurse -Force
        }
    }
}

$content = Get-SuiteReleaseActualContentMap -SuiteRoot $suiteRoot -TargetRoot $portableDir -Layout 'Portable'
$fingerprint = New-SuiteReleaseFingerprint `
    -SuiteRoot $suiteRoot `
    -TargetName 'portable artifact' `
    -TargetRole 'generated portable artifact' `
    -ReleaseRunId $env:CTI_RELEASE_RUN_ID `
    -Content $content `
    -ManifestSummary (Get-ReleaseManifestSummary -Root $portableDir) `
    -PanelSummary (Get-ReleasePanelSummary -Path (Join-Path $portableDir 'CodexImSuiteControlPanel.exe'))
Write-SuiteReleaseFingerprint -TargetRoot $portableDir -Fingerprint $fingerprint | Out-Null

$zipPath = Join-Path (Join-Path $suiteRoot 'release') 'codex-im-suite-portable.zip'
$zipTempPath = "$zipPath.tmp-$([guid]::NewGuid().ToString('N')).zip"
Remove-FileWithRetry -Path $zipTempPath
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $portableDir,
        $zipTempPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false,
        [System.Text.Encoding]::UTF8)
    Remove-FileWithRetry -Path $zipPath
    Move-Item -LiteralPath $zipTempPath -Destination $zipPath -Force
}
finally {
    Remove-FileWithRetry -Path $zipTempPath
}
Write-Host "portable assembled: $portableDir"
Write-Host "portable zip: $zipPath"
