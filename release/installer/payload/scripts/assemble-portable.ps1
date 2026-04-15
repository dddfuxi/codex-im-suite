$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$portableDir = Join-Path $suiteRoot 'release\portable'
$artifactsDir = Join-Path $suiteRoot 'release\artifacts'
$manifest = Get-SuiteManifest -SuiteRoot $suiteRoot

Remove-Item -LiteralPath $portableDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null

Copy-Item -LiteralPath (Join-Path $artifactsDir 'control-panel\CodexImSuiteControlPanel.exe') -Destination $portableDir -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'suite.manifest.json') -Destination $portableDir -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'README.md') -Destination $portableDir -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'config') -Destination (Join-Path $portableDir 'config') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $suiteRoot 'scripts') -Destination (Join-Path $portableDir 'scripts') -Recurse -Force

$packagesDir = Join-Path $portableDir 'packages'
New-Item -ItemType Directory -Force -Path $packagesDir | Out-Null

foreach ($pkgName in $manifest.packages.PSObject.Properties.Name) {
    $pkg = $manifest.packages.$pkgName
    $src = [System.IO.Path]::GetFullPath((Join-Path $suiteRoot $pkg.path))
    $dst = Join-Path $packagesDir $pkgName
    New-Item -ItemType Directory -Force -Path $dst | Out-Null

    foreach ($name in @('dist', 'scripts', 'config.env.example', 'package.json', 'package-lock.json', 'README.md', 'README_CN.md', 'README.zh-CN.md')) {
        $item = Join-Path $src $name
        if (Test-Path -LiteralPath $item) {
            Copy-Item -LiteralPath $item -Destination $dst -Recurse -Force
        }
    }
}

$zipPath = Join-Path (Join-Path $suiteRoot 'release') 'codex-im-suite-portable.zip'
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $portableDir '*') -DestinationPath $zipPath -Force
Write-Host "portable assembled: $portableDir"
Write-Host "portable zip: $zipPath"
