$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$portableDir = Join-Path $suiteRoot 'release\portable'
$installerDir = Join-Path $suiteRoot 'release\installer'
$project = Join-Path $suiteRoot 'apps\installer\CodexImSuite.Installer.csproj'

Remove-Item -LiteralPath $installerDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $installerDir 'payload') | Out-Null
Copy-Item -Path (Join-Path $portableDir '*') -Destination (Join-Path $installerDir 'payload') -Recurse -Force

dotnet publish $project -c Release -r win-x64 --self-contained false -p:PublishSingleFile=false -o $installerDir
if ($LASTEXITCODE -ne 0) {
    throw "installer publish failed"
}
Write-Host "installer built: $installerDir"
