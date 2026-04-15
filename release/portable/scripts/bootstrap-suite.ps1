$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$manifest = Get-SuiteManifest -SuiteRoot $suiteRoot

function Install-PackageDeps {
    param([string]$Path)
    Write-Host "install deps: $Path"
    Push-Location $Path
    try {
        npm install | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed at $Path"
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($pkgName in $manifest.packages.PSObject.Properties.Name) {
    $pkg = $manifest.packages.$pkgName
    $path = [System.IO.Path]::GetFullPath((Join-Path $suiteRoot $pkg.path))
    Install-PackageDeps -Path $path
}

dotnet restore (Join-Path $suiteRoot 'apps\control-panel\CodexImSuite.ControlPanel.csproj') | Out-Host
dotnet restore (Join-Path $suiteRoot 'apps\installer\CodexImSuite.Installer.csproj') | Out-Host
Write-Host "suite bootstrap complete"
