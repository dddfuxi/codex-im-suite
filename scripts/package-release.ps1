$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $scriptDir 'build-packages.ps1')
& (Join-Path $scriptDir 'assemble-portable.ps1')
& (Join-Path $scriptDir 'build-installer.ps1')
