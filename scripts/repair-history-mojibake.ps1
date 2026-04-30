param(
    [string]$CtiHome = "",
    [string]$MemoryRoot = "",
    [string]$Restore = "",
    [string]$Channels = "",
    [switch]$Apply,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$runtimeDir = Join-Path $suiteRoot 'packages\bridge-runtime'

$argsList = @('--import', 'tsx', 'src/repair-history-mojibake.ts')
if ($Apply) { $argsList += '--apply' }
if ($Json) { $argsList += '--json' }
if ($CtiHome.Trim()) { $argsList += @('--cti-home', $CtiHome.Trim()) }
if ($MemoryRoot.Trim()) { $argsList += @('--memory-root', $MemoryRoot.Trim()) }
if ($Restore.Trim()) { $argsList += @('--restore', $Restore.Trim()) }
if ($Channels.Trim()) { $argsList += @('--channels', $Channels.Trim()) }

Push-Location $runtimeDir
try {
    & node @argsList
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
