param(
    [string]$HostName = "",
    [int]$Port = 8788,
    [string]$AuthToken = "",
    [ValidateSet("viewer", "operator", "owner")]
    [string]$AuthRole = "viewer",
    [switch]$AllowRemote,
    [switch]$AllowRemoteDangerous,
    [switch]$UsePublished,
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$publishedExe = Join-Path $suiteRoot "release\artifacts\control-panel\CodexImSuiteControlPanel.exe"
$projectPath = Join-Path $suiteRoot "apps\control-panel\CodexImSuite.ControlPanel.csproj"

if ([string]::IsNullOrWhiteSpace($HostName)) {
    $HostName = if ($env:CTI_CONTROL_API_HOST) { $env:CTI_CONTROL_API_HOST } elseif ($env:CTI_CONTROL_API_BIND) { $env:CTI_CONTROL_API_BIND } else { "127.0.0.1" }
}

$isLoopback = $HostName -in @("127.0.0.1", "localhost", "::1")
$isWildcard = $HostName -in @("0.0.0.0", "*", "+")
if (($isWildcard -or -not $isLoopback) -and -not $AllowRemote -and $env:CTI_CONTROL_API_ALLOW_REMOTE -ne "true") {
    throw "Remote bind requires -AllowRemote or CTI_CONTROL_API_ALLOW_REMOTE=true."
}

if (($isWildcard -or -not $isLoopback) -and [string]::IsNullOrWhiteSpace($AuthToken) -and [string]::IsNullOrWhiteSpace($env:CTI_CONTROL_API_AUTH_TOKEN)) {
    throw "Remote bind requires -AuthToken or CTI_CONTROL_API_AUTH_TOKEN."
}

$env:CTI_CONTROL_API_ENABLED = "true"
$env:CTI_CONTROL_API_HOST = $HostName
$env:CTI_CONTROL_API_PORT = [string]$Port
if ($AllowRemote) { $env:CTI_CONTROL_API_ALLOW_REMOTE = "true" }
if ($AllowRemoteDangerous) { $env:CTI_CONTROL_API_ALLOW_REMOTE_DANGEROUS = "true" }
if (-not [string]::IsNullOrWhiteSpace($AuthToken)) { $env:CTI_CONTROL_API_AUTH_TOKEN = $AuthToken }
if ($AuthRole) { $env:CTI_CONTROL_API_AUTH_ROLE = $AuthRole }

$baseUrlHost = if ($isWildcard) { "127.0.0.1" } else { $HostName }
$baseUrl = "http://${baseUrlHost}:$Port"

if ($UsePublished -or (Test-Path -LiteralPath $publishedExe)) {
    if (-not (Test-Path -LiteralPath $publishedExe)) {
        throw "Published control panel was not found: $publishedExe. Run scripts\package-release.ps1 first."
    }
    if ($Foreground) {
        & $publishedExe --api-only
        exit $LASTEXITCODE
    }
    $process = Start-Process -FilePath $publishedExe -ArgumentList "--api-only" -WindowStyle Hidden -PassThru
    Write-Host "Control API started: $baseUrl"
    Write-Host "PID: $($process.Id)"
    exit 0
}

if ($Foreground) {
    dotnet run --project $projectPath -- --api-only
    exit $LASTEXITCODE
}

$process = Start-Process -FilePath "dotnet" -ArgumentList @("run", "--project", $projectPath, "--", "--api-only") -WorkingDirectory $suiteRoot -WindowStyle Hidden -PassThru
Write-Host "Control API started: $baseUrl"
Write-Host "PID: $($process.Id)"
