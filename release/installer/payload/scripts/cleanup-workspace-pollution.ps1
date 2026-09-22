param(
    [Parameter(Mandatory = $false)]
    [string[]]$Target,

    [Parameter(Mandatory = $false)]
    [switch]$Apply,

    [Parameter(Mandatory = $false)]
    [string]$ApplyManifest,

    [Parameter(Mandatory = $false)]
    [string]$RestoreManifest,

    [Parameter(Mandatory = $false)]
    [string]$CtiHome = (Join-Path $env:USERPROFILE '.claude-to-im'),

    [Parameter(Mandatory = $false)]
    [string]$MemoryRoot = $env:CTI_MEMORY_REPO_DIR,

    [Parameter(Mandatory = $false)]
    [string]$Now,

    [Parameter(Mandatory = $false)]
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$suiteRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $suiteRoot 'packages\bridge-runtime'
$cliPath = Join-Path $runtimeRoot 'dist\cleanup-cli.mjs'

if (-not $SkipBuild) {
    Push-Location $suiteRoot
    try {
        & npm --workspace packages/bridge-runtime run build
        if ($LASTEXITCODE -ne 0) {
            throw "Bridge runtime build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Workspace cleanup CLI is not built: $cliPath"
}

$arguments = @($cliPath, '--cti-home', [System.IO.Path]::GetFullPath($CtiHome))
if (-not [string]::IsNullOrWhiteSpace($MemoryRoot)) {
    $arguments += @('--memory-root', [System.IO.Path]::GetFullPath($MemoryRoot))
}
if (-not [string]::IsNullOrWhiteSpace($ApplyManifest)) {
    if ($Target -or $Apply -or -not [string]::IsNullOrWhiteSpace($RestoreManifest)) {
        throw '-ApplyManifest cannot be combined with -Target, -Apply, or -RestoreManifest.'
    }
    $arguments += @('--apply-manifest', [System.IO.Path]::GetFullPath($ApplyManifest))
}
elseif (-not [string]::IsNullOrWhiteSpace($RestoreManifest)) {
    $arguments += @('--restore', [System.IO.Path]::GetFullPath($RestoreManifest))
}
else {
    if (-not $Target -or $Target.Count -eq 0) {
        throw 'At least one -Target is required unless -RestoreManifest is provided.'
    }
    foreach ($item in $Target) {
        $arguments += @('--target', [System.IO.Path]::GetFullPath($item))
    }
    if ($Apply) {
        $arguments += '--apply'
    }
}
if (-not [string]::IsNullOrWhiteSpace($Now)) {
    $arguments += @('--now', $Now)
}

& node @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Workspace cleanup failed with exit code $LASTEXITCODE."
}
