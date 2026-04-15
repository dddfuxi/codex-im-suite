param(
    [string]$ManifestDir
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$skillDir = Split-Path -Parent $scriptDir
if (-not $ManifestDir) {
    $ManifestDir = Join-Path $skillDir 'mcp.d'
}

function Ensure-CodexCli {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codex) {
        throw "codex CLI missing from PATH."
    }
}

function Read-EnvFile {
    $configPath = Join-Path $env:USERPROFILE '.claude-to-im\config.env'
    $values = @{}
    if (-not (Test-Path -LiteralPath $configPath)) {
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $configPath -Encoding UTF8) {
        if (-not $line -or $line.TrimStart().StartsWith('#')) { continue }
        $index = $line.IndexOf('=')
        if ($index -le 0) { continue }
        $key = $line.Substring(0, $index).Trim()
        $value = $line.Substring($index + 1).Trim()
        $values[$key] = $value
    }
    return $values
}

function Expand-ManifestValue {
    param(
        [string]$Value,
        [hashtable]$EnvValues
    )
    if ($null -eq $Value) { return $null }
    $expanded = $Value
    $expanded = $expanded.Replace('${SKILL_DIR}', $skillDir)
    $expanded = $expanded.Replace('${CTI_HOME}', (Join-Path $env:USERPROFILE '.claude-to-im'))
    $expanded = $expanded.Replace('${USERPROFILE}', $env:USERPROFILE)
    foreach ($key in $EnvValues.Keys) {
        $expanded = $expanded.Replace(('${' + $key + '}'), [string]$EnvValues[$key])
    }
    return [Environment]::ExpandEnvironmentVariables($expanded)
}

function Upsert-StdioServer {
    param(
        [string]$Name,
        [string]$LauncherPath
    )

    $existing = codex mcp list
    if ($existing -match ("(?m)^" + [regex]::Escape($Name) + "\s")) {
        codex mcp remove $Name | Out-Host
    }

    codex mcp add $Name -- powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $LauncherPath | Out-Host
}

if (-not (Test-Path -LiteralPath $ManifestDir)) {
    throw "MCP manifest directory not found: $ManifestDir"
}

Ensure-CodexCli
$envValues = Read-EnvFile
$manifests = Get-ChildItem -LiteralPath $ManifestDir -Filter '*.json' -File | Sort-Object Name
foreach ($file in $manifests) {
    $manifest = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($manifest.enabled -eq $false) {
        Write-Host "skip disabled MCP manifest: $($file.Name)"
        continue
    }
    if ($manifest.type -ne 'stdio') {
        Write-Host "skip non-stdio MCP manifest: $($file.Name)"
        continue
    }

    $name = if ($manifest.registerName) { [string]$manifest.registerName } else { [string]$manifest.id }
    if (-not $name) {
        Write-Warning "skip MCP manifest without id/registerName: $($file.FullName)"
        continue
    }

    $launcher = Expand-ManifestValue -Value ([string]$manifest.launcher) -EnvValues $envValues
    if (-not [System.IO.Path]::IsPathRooted($launcher)) {
        $launcher = Join-Path $skillDir $launcher
    }
    if (-not (Test-Path -LiteralPath $launcher)) {
        Write-Warning "skip MCP $name because launcher is missing: $launcher"
        continue
    }

    Write-Host "register MCP: $name -> $launcher"
    Upsert-StdioServer -Name $name -LauncherPath $launcher
}

codex mcp list | Out-Host
