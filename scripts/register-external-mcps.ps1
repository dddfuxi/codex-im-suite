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
$ctiHome = if ([string]::IsNullOrWhiteSpace($env:CTI_HOME)) { Join-Path $env:USERPROFILE '.claude-to-im' } else { [string]$env:CTI_HOME }
$overlayManifestDir = Join-Path $ctiHome 'extensions\manifests\mcp.d'

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    throw "codex CLI missing from PATH."
}

$files = @()
foreach ($dir in @($ManifestDir, $overlayManifestDir)) {
    if (Test-Path -LiteralPath $dir) {
        $files += @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Sort-Object Name)
    }
}

$manifestsById = [ordered]@{}
foreach ($file in $files) {
    $item = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
    $id = [string]$item.id
    if ([string]::IsNullOrWhiteSpace($id)) { continue }
    $manifestsById[$id] = [pscustomobject]@{
        Item = $item
        File = $file
    }
}

foreach ($entry in $manifestsById.Values) {
    $item = $entry.Item
    if ($item.enabled -eq $false) { continue }
    if ($item.type -ne 'stdio' -and $item.type -ne 'http') { continue }

    $name = if ($item.registerName) { [string]$item.registerName } else { [string]$item.id }
    $launcher = Expand-SuiteValue -Value ([string]$item.launcher) -SuiteRoot $suiteRoot -Config $config
    $healthUrl = $null
    if ($item.healthCheck -and $item.healthCheck.url) {
        $healthUrl = Expand-SuiteValue -Value ([string]$item.healthCheck.url) -SuiteRoot $suiteRoot -Config $config
    }
    $envArgs = @()
    if ($item.env) {
        foreach ($property in $item.env.PSObject.Properties) {
            $key = [string]$property.Name
            if ([string]::IsNullOrWhiteSpace($key)) { continue }
            $value = Expand-SuiteValue -Value ([string]$property.Value) -SuiteRoot $suiteRoot -Config $config
            $envArgs += @('--env', "$key=$value")
        }
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
    codex mcp add $name @envArgs -- powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $launcher | Out-Host
}

codex mcp list | Out-Host
