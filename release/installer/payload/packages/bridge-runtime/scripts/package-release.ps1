$ErrorActionPreference = 'Stop'

function Find-SuiteRoot {
    $candidates = @(
        $env:CODEX_IM_SUITE_ROOT,
        (Join-Path (Join-Path $env:USERPROFILE 'Documents\New project') 'codex-im-suite')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    $cursor = Split-Path -Parent $MyInvocation.MyCommand.Path
    while ($cursor) {
        $candidates += $cursor
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }

    foreach ($candidate in $candidates) {
        $manifest = Join-Path $candidate 'suite.manifest.json'
        $script = Join-Path $candidate 'scripts\package-release.ps1'
        if ((Test-Path -LiteralPath $manifest) -and (Test-Path -LiteralPath $script)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

$suiteRoot = Find-SuiteRoot
if (-not $suiteRoot) {
    throw 'Legacy bridge-runtime package-release.ps1 is disabled and no suite root was found. Run scripts/package-release.ps1 from codex-im-suite.'
}

Write-Host "Delegating to suite package release: $suiteRoot"
& (Join-Path $suiteRoot 'scripts\package-release.ps1')
