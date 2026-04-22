param(
    [string]$ManifestDir
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$manifest = Get-SuiteManifest -SuiteRoot $suiteRoot
$config = Get-CtiConfig
& (Join-Path $scriptDir 'validate-extension-manifests.ps1')
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
    if ($item.type -ne 'stdio' -and $item.type -ne 'http') { continue }

    $name = if ($item.registerName) { [string]$item.registerName } else { [string]$item.id }
    $launcher = Expand-SuiteValue -Value ([string]$item.launcher) -SuiteRoot $suiteRoot -Config $config
    $healthUrl = $null
    if ($item.healthCheck -and $item.healthCheck.url) {
        $healthUrl = Expand-SuiteValue -Value ([string]$item.healthCheck.url) -SuiteRoot $suiteRoot -Config $config
    }

    if ($item.type -eq 'http') {
        $url = if ($healthUrl) { $healthUrl } else { $launcher }
        if (-not $url) {
            Write-Warning "skip $name because http url is missing."
            continue
        }

        $existing = codex mcp list
        if ($existing -match ("(?m)^" + [regex]::Escape($name) + "\s")) {
            codex mcp remove $name | Out-Host
        }
        codex mcp add $name --url $url | Out-Host
        continue
    }

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
