$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$manifestDir = Join-Path $suiteRoot 'config\skills.d'
$ctiHome = if ([string]::IsNullOrWhiteSpace($env:CTI_HOME)) { Join-Path $env:USERPROFILE '.claude-to-im' } else { [string]$env:CTI_HOME }
$overlayManifestDir = Join-Path $ctiHome 'extensions\manifests\skills.d'
$skillsRoot = Join-Path $suiteRoot 'extensions\skills'
$targetRoot = Join-Path $env:USERPROFILE '.codex\skills'

function Resolve-ManifestValue {
    param(
        [string]$Value,
        [string]$SuiteRoot
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { return $Value }
    $result = $Value.Replace('${SUITE_ROOT}', $SuiteRoot)
    $result = $result.Replace('${CTI_HOME}', $script:ctiHome)
    $result = $result.Replace('${USERPROFILE}', $env:USERPROFILE)
    return [Environment]::ExpandEnvironmentVariables($result)
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

$manifestFiles = @()
foreach ($dir in @($manifestDir, $overlayManifestDir)) {
    if (Test-Path -LiteralPath $dir) {
        $manifestFiles += @(Get-ChildItem -LiteralPath $dir -Filter *.json -File | Sort-Object Name)
    }
}

$manifestsById = [ordered]@{}
foreach ($manifestFile in $manifestFiles) {
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $id = [string]$manifest.id
    if ([string]::IsNullOrWhiteSpace($id)) { continue }
    $manifestsById[$id] = [pscustomobject]@{
        Manifest = $manifest
        File = $manifestFile
    }
}

foreach ($entry in $manifestsById.Values) {
    $manifest = $entry.Manifest
    if ($manifest.type -ne 'skill') { continue }
    if ($manifest.enabled -eq $false) { continue }

    $source = Resolve-ManifestValue -Value ([string]$manifest.source) -SuiteRoot $suiteRoot
    $target = Join-Path $targetRoot ([string]$manifest.id)

    if (-not (Test-Path -LiteralPath $source)) {
        Write-Warning "Skill source not found: $source"
        continue
    }

    New-Item -ItemType Directory -Force -Path $target | Out-Null
    robocopy $source $target /MIR /XD .git node_modules dist bin obj | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed ($code): $source -> $target"
    }

    Write-Output "installed skill: $($manifest.id)"
}

Write-Output "suite skills synced to $targetRoot"
