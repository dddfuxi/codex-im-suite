$ErrorActionPreference = 'Stop'

function Get-SuiteRoot {
    return Split-Path -Parent $PSScriptRoot
}

function Get-SuiteManifest {
    param([string]$SuiteRoot)
    $manifestPath = Join-Path $SuiteRoot 'suite.manifest.json'
    return Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
}

function Get-CtiConfig {
    $path = Join-Path $env:USERPROFILE '.claude-to-im\config.env'
    $values = @{}
    if (-not (Test-Path -LiteralPath $path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
        if (-not $line -or $line.TrimStart().StartsWith('#')) { continue }
        $index = $line.IndexOf('=')
        if ($index -le 0) { continue }
        $values[$line.Substring(0, $index).Trim()] = $line.Substring($index + 1).Trim()
    }
    return $values
}

function Expand-SuiteValue {
    param(
        [string]$Value,
        [string]$SuiteRoot,
        [hashtable]$Config
    )
    if ($null -eq $Value) { return $null }
    $result = $Value
    $result = $result.Replace('${SUITE_ROOT}', $SuiteRoot)
    $result = $result.Replace('${CTI_HOME}', (Join-Path $env:USERPROFILE '.claude-to-im'))
    $result = $result.Replace('${USERPROFILE}', $env:USERPROFILE)
    foreach ($key in $Config.Keys) {
        $result = $result.Replace(('${' + $key + '}'), [string]$Config[$key])
    }
    return [Environment]::ExpandEnvironmentVariables($result)
}
