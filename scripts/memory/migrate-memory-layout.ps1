param(
    [Parameter(Mandatory = $false)]
    [string]$MemoryRoot = $env:CTI_MEMORY_REPO_DIR,

    [Parameter(Mandatory = $false)]
    [switch]$Apply,

    [Parameter(Mandatory = $false)]
    [string]$ReportPath,

    [Parameter(Mandatory = $false)]
    [string]$Now
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ([string]::IsNullOrWhiteSpace($MemoryRoot)) {
    throw 'Memory root is required. Pass -MemoryRoot or set CTI_MEMORY_REPO_DIR.'
}

$suiteRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cliPath = Join-Path $suiteRoot 'packages\bridge-runtime\dist\memory-layout-migration-cli.mjs'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Migration CLI is not built: $cliPath. Run npm --workspace packages/bridge-runtime run build first."
}

$arguments = @($cliPath, '--memory-root', [System.IO.Path]::GetFullPath($MemoryRoot))
if ($Apply) {
    $arguments += '--apply'
}
if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
    $arguments += @('--report', [System.IO.Path]::GetFullPath($ReportPath))
}
if (-not [string]::IsNullOrWhiteSpace($Now)) {
    $arguments += @('--now', $Now)
}

& node @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Memory layout migration failed with exit code $LASTEXITCODE."
}
