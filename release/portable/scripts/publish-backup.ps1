$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir

& (Join-Path $scriptDir 'sync-live-skill.ps1')
& (Join-Path $scriptDir 'package-release.ps1')

Push-Location $suiteRoot
try {
    git add .
    if (-not (git diff --cached --quiet)) {
        $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        git commit -m "Backup suite snapshot $timestamp"
    }
    git push
}
finally {
    Pop-Location
}
