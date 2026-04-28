param(
    [string]$ControlPanelArtifactDir
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

Assert-NoRunningProcessInPath -Roots @($portableDir) -Purpose 'assemble portable'
if (Test-Path -LiteralPath $portableDir) {
    try {
        Remove-Item -LiteralPath $portableDir -Recurse -Force -ErrorAction Stop
    }
    catch {
        throw "无法清理 portable 目录：$portableDir。请确认没有正在运行的 portable 程序或资源管理器占用后重试。原始错误：$($_.Exception.Message)"
    }
}
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null

Get-ChildItem -LiteralPath $ControlPanelArtifactDir -Force |
    Where-Object { $_.Name -notlike '*.pdb' } |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $portableDir -Recurse -Force
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
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $portableDir '*') -DestinationPath $zipPath -Force
Write-Host "portable assembled: $portableDir"
Write-Host "portable zip: $zipPath"
