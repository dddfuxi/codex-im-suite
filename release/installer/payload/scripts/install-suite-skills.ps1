$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$manifestDir = Join-Path $suiteRoot 'config\skills.d'
$skillsRoot = Join-Path $suiteRoot 'extensions\skills'
$targetRoot = Join-Path $env:USERPROFILE '.codex\skills'

function Resolve-ManifestValue {
    param(
        [string]$Value,
        [string]$SuiteRoot
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { return $Value }
    return $Value.Replace('${SUITE_ROOT}', $SuiteRoot)
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

$manifests = Get-ChildItem -LiteralPath $manifestDir -Filter *.json -File | Sort-Object Name

foreach ($manifestFile in $manifests) {
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
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
