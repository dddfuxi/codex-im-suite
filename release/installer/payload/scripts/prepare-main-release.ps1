param(
    [switch]$RequireClean
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$publishSummaryPath = Join-Path $suiteRoot 'publish-summary.md'
$releaseNotesPath = Join-Path $suiteRoot 'release-notes.md'

function Get-SuiteVersion {
    $manifestPath = Join-Path $suiteRoot 'suite.manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$manifest.version
}

function Invoke-GitText {
    param([string[]]$GitArgs)
    Push-Location $suiteRoot
    try {
        return (& git @GitArgs 2>$null) -join [Environment]::NewLine
    }
    finally {
        Pop-Location
    }
}

function Get-GitStatusLines {
    Push-Location $suiteRoot
    try {
        return @(git status --short)
    }
    finally {
        Pop-Location
    }
}

function Test-ActionableSecretHit {
    param([string]$Line)

    $trimmed = $Line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $false
    }

    if ($trimmed.StartsWith('#') -and $trimmed -match '(?i)(your-|example|placeholder|change-me|changeme|dummy|sample|<[^>]+>)') {
        return $false
    }

    $assignment = [regex]::Match($trimmed, '(?i)(app[_-]?secret|client[_-]?secret|access[_-]?token|api[_-]?key)\s*[:=]\s*["'']?([^"''\s#]+)')
    if ($assignment.Success) {
        $value = $assignment.Groups[2].Value.Trim()
        if ($value -match '(?i)^(your-|example|placeholder|change-me|changeme|replace-me|dummy|sample|test)') {
            return $false
        }
        if ($value -match '^[A-Z][A-Z0-9_]+$') {
            return $false
        }
    }

    return $true
}

function Assert-NoSecretLeak {
    $patterns = @(
        'sk-[A-Za-z0-9_-]{16,}',
        'xox[baprs]-[A-Za-z0-9-]{16,}',
        '(?i)(app[_-]?secret|client[_-]?secret|access[_-]?token|api[_-]?key)\s*[:=]\s*["'']?[A-Za-z0-9_\-]{20,}'
    )
    $roots = @('apps', 'config', 'docs', 'extensions', 'packages', 'scripts', 'AGENTS.md', 'README.md', 'suite.manifest.json')
    $secretHits = New-Object System.Collections.Generic.List[string]

    foreach ($root in $roots) {
        $path = Join-Path $suiteRoot $root
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $items = if ((Get-Item -LiteralPath $path).PSIsContainer) {
            Get-ChildItem -LiteralPath $path -Recurse -File -Include *.cs,*.json,*.md,*.mjs,*.ps1,*.ts,*.js |
                Where-Object { $_.FullName -notmatch '\\(node_modules|dist|bin|obj|release)\\' }
        } else {
            @(Get-Item -LiteralPath $path)
        }
        foreach ($item in $items) {
            foreach ($pattern in $patterns) {
                $hit = Select-String -Path $item.FullName -Pattern $pattern -Encoding UTF8 -ErrorAction SilentlyContinue |
                    Where-Object { Test-ActionableSecretHit $_.Line } |
                    Select-Object -First 1
                if ($hit) {
                    $secretHits.Add("$($item.FullName):$($hit.LineNumber)") | Out-Null
                }
            }
        }
    }

    if ($secretHits.Count -gt 0) {
        throw "Potential secret or token leak: $($secretHits -join '; ')"
    }
}

function Write-MainReleaseSummary {
    param(
        [string]$Version,
        [string]$Branch,
        [string]$Commit,
        [string[]]$StatusLines
    )

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $tag = "v$Version"
    $summaryLines = New-Object System.Collections.Generic.List[string]
    $summaryLines.Add('# Publish Summary')
    $summaryLines.Add('')
    $summaryLines.Add("- Time: $timestamp")
    $summaryLines.Add("- Subject: prepare main release $tag")
    $summaryLines.Add("- Summary source: main-release-preflight")
    $summaryLines.Add('')
    $summaryLines.Add('## Preview')
    $summaryLines.Add('')
    $summaryLines.Add("- Suite version: $Version")
    $summaryLines.Add("- Branch: $Branch")
    $summaryLines.Add("- Commit: $Commit")
    $summaryLines.Add("- Extension manifests: validated")
    $summaryLines.Add("- Architecture docs: checked")
    $summaryLines.Add("- Package: built without live skill sync")
    if ($StatusLines.Count -gt 0) {
        $summaryLines.Add('')
        $summaryLines.Add('## Pending Git Changes')
        $summaryLines.Add('')
        foreach ($line in ($StatusLines | Select-Object -First 40)) {
            $summaryLines.Add("- $($line.Trim())")
        }
        if ($StatusLines.Count -gt 40) {
            $summaryLines.Add("- ... and $($StatusLines.Count - 40) more")
        }
    }
    Set-Content -LiteralPath $publishSummaryPath -Value $summaryLines -Encoding UTF8

    $entry = New-Object System.Collections.Generic.List[string]
    $entry.Add("## $timestamp")
    $entry.Add('')
    $entry.Add("- Subject: prepare main release $tag")
    $entry.Add("- Summary source: main-release-preflight")
    $entry.Add('')
    $entry.Add('### Preview')
    $entry.Add('')
    $entry.Add("- Suite version: $Version")
    $entry.Add("- Branch policy: main is stable, codex/dev is integration, codex/<topic> is feature work")
    $entry.Add("- Extension protocol: extension-manifest/v1")
    $entry.Add("- Package mode: main release packaging skipped live skill sync")
    $entryText = ($entry -join [Environment]::NewLine).TrimEnd()

    if (Test-Path -LiteralPath $releaseNotesPath) {
        $existing = Get-Content -LiteralPath $releaseNotesPath -Raw -Encoding UTF8
        $body = $existing -replace '^\# Release Notes\r?\n\r?\n', ''
        $escapedTag = [regex]::Escape($tag)
        $existingEntryPattern = "(?ms)^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\r?\n\r?\n- Subject: prepare main release $escapedTag\r?\n- Summary source: main-release-preflight\r?\n.*?(?=^## |\z)"
        $body = [regex]::Replace($body, $existingEntryPattern, '').TrimStart()
        $combined = "# Release Notes`r`n`r`n$entryText`r`n`r`n$body"
        Set-Content -LiteralPath $releaseNotesPath -Value $combined -Encoding UTF8
    } else {
        Set-Content -LiteralPath $releaseNotesPath -Value "# Release Notes`r`n`r`n$entryText`r`n" -Encoding UTF8
    }
}

$version = Get-SuiteVersion
$branch = (Invoke-GitText @('branch', '--show-current')).Trim()
$commit = (Invoke-GitText @('rev-parse', '--short', 'HEAD')).Trim()
$statusBefore = Get-GitStatusLines

if ($RequireClean -and $statusBefore.Count -gt 0) {
    throw "RequireClean is set, but the worktree is dirty. Commit or stash changes first."
}

& (Join-Path $scriptDir 'validate-extension-manifests.ps1')
& (Join-Path $scriptDir 'update-architecture-docs.ps1')
Assert-NoSecretLeak
& (Join-Path $scriptDir 'package-main-release.ps1')

$statusAfter = Get-GitStatusLines
Write-MainReleaseSummary -Version $version -Branch $branch -Commit $commit -StatusLines $statusAfter

Write-Host "main release preflight complete for v$version"
Write-Host "after reviewing, committing, and pushing release files, create the release tag with scripts/create-main-release-tag.ps1"
