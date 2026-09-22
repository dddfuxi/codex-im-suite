param(
    [switch]$AllowNonMain
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$manifestPath = Join-Path $suiteRoot 'suite.manifest.json'

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

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
$stableBranch = if ($manifest.branches -and $manifest.branches.stable) { [string]$manifest.branches.stable } else { 'main' }
$tagName = "v$version"
$branch = (Invoke-GitText @('branch', '--show-current')).Trim()
$status = @(Invoke-GitText @('status', '--short') -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

if ($status.Count -gt 0) {
    throw "Worktree is dirty. Commit and push release files before creating $tagName."
}

if (-not $AllowNonMain -and $branch -ne $stableBranch) {
    throw "Current branch is '$branch'. Switch to stable branch '$stableBranch' or pass -AllowNonMain intentionally."
}

& (Join-Path $scriptDir 'validate-extension-manifests.ps1') -Strict

$existingTag = (Invoke-GitText @('tag', '--list', $tagName)).Trim()
if (-not [string]::IsNullOrWhiteSpace($existingTag)) {
    throw "Tag already exists: $tagName"
}

Push-Location $suiteRoot
try {
    git tag -a $tagName -m "codex-im-suite $tagName"
    if ($LASTEXITCODE -ne 0) {
        throw "git tag failed for $tagName"
    }
}
finally {
    Pop-Location
}

Write-Host "created tag: $tagName"
