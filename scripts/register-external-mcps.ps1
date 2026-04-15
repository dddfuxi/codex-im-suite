param(
    [string]$ManifestDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$manifest = Get-SuiteManifest -SuiteRoot $suiteRoot
$config = Get-CtiConfig
if (-not $ManifestDir) {
    $ManifestDir = Join-Path $suiteRoot 'config\mcp.d'
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    throw "codex CLI missing from PATH."
}

$files = Get-ChildItem -LiteralPath $ManifestDir -Filter '*.json' -File | Sort-Object Name
foreach ($file in $files) {
    $item = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($item.enabled -eq $false) { continue }
    if ($item.type -ne 'stdio') { continue }

    $name = if ($item.registerName) { [string]$item.registerName } else { [string]$item.id }
    $launcher = Expand-SuiteValue -Value ([string]$item.launcher) -SuiteRoot $suiteRoot -Config $config
    if (-not (Test-Path -LiteralPath $launcher)) {
        Write-Warning "skip $name because launcher is missing: $launcher"
        continue
    }

    $existing = codex mcp list
    if ($existing -match ("(?m)^" + [regex]::Escape($name) + "\s")) {
        codex mcp remove $name | Out-Host
    }
    codex mcp add $name -- powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $launcher | Out-Host
}

codex mcp list | Out-Host
