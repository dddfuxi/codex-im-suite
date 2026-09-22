param(
    [string]$MemoryRepo = $(if ($env:CTI_MEMORY_REPO_DIR) { $env:CTI_MEMORY_REPO_DIR } else { 'E:\cli-md' }),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath {
    param([string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Test-IsChildPath {
    param(
        [string]$Candidate,
        [string]$Root
    )
    $candidatePath = (Resolve-FullPath $Candidate).TrimEnd('\', '/')
    $rootPath = (Resolve-FullPath $Root).TrimEnd('\', '/')
    return $candidatePath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $candidatePath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativePathCompat {
    param(
        [string]$BasePath,
        [string]$TargetPath
    )
    $baseFull = (Resolve-FullPath $BasePath).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $targetFull = Resolve-FullPath $TargetPath
    if ($targetFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $targetFull.Substring($baseFull.Length)
    }
    return [System.IO.Path]::GetFileName($targetFull)
}

$root = Resolve-FullPath $MemoryRepo
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Memory repo not found: $root"
}

$archiveRoot = Join-Path $root 'archive\legacy-rules'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$targetRoot = Join-Path $archiveRoot $stamp

$candidates = Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.md |
    Where-Object {
        $full = Resolve-FullPath $_.FullName
        -not (Test-IsChildPath $full (Join-Path $root '.cti-index')) -and
        -not (Test-IsChildPath $full (Join-Path $root 'archive')) -and
        $_.Name -ne 'AUTHORITATIVE-RULES.md'
    } |
    Where-Object {
        $nameHit = $_.Name -match '(rule|rules|\u89c4\u5219|\u7ea6\u5b9a|\u89c4\u8303|prompt|\u63d0\u793a\u8bcd)'
        $content = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
        $contentHit = $content -match '(\u65e7\u89c4\u5219|legacy|\u5fc5\u987b|\u4e0d\u8981|\u7981\u6b62|\u9ed8\u8ba4|\u7ea6\u5b9a|\u6700\u9ad8\u4f18\u5148\u7ea7|prompt|system)'
        $nameHit -or $contentHit
    }

$summary = @()
$summary += "# legacy-rules archive summary"
$summary += ""
$summary += "- memoryRepo: $root"
$summary += "- generatedAt: $(Get-Date -Format o)"
$summary += "- mode: $(if ($Apply) { 'apply' } else { 'dry-run' })"
$summary += "- candidateCount: $($candidates.Count)"
$summary += ""

foreach ($file in $candidates) {
    $relative = Get-RelativePathCompat $root $file.FullName
    $summary += "- $relative"
}

if (-not $Apply) {
    $summary -join [Environment]::NewLine
    exit 0
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

foreach ($file in $candidates) {
    $relative = Get-RelativePathCompat $root $file.FullName
    $target = Join-Path $targetRoot $relative
    $targetDir = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    if (-not (Test-IsChildPath $target $targetRoot)) {
        throw "Refusing to move outside archive root: $target"
    }
    Move-Item -LiteralPath $file.FullName -Destination $target
}

$summaryPath = Join-Path $targetRoot 'archive-summary.md'
Set-Content -LiteralPath $summaryPath -Value ($summary -join [Environment]::NewLine) -Encoding UTF8

$authoritativeRules = @(
    '# AUTHORITATIVE-RULES',
    '',
    "Updated: $(Get-Date -Format 'yyyy-MM-dd')",
    '',
    'This file is the single entry created after archiving legacy rule Markdown files.',
    'Current project rules are AGENTS.md, docs/PROJECT-ARCHITECTURE.md, and docs/DEVELOPMENT-LOG.md.',
    '',
    'Legacy archive batch:',
    '',
    "- $summaryPath"
)
Set-Content -LiteralPath (Join-Path $root 'AUTHORITATIVE-RULES.md') -Value ($authoritativeRules -join [Environment]::NewLine) -Encoding UTF8

Write-Output "archived: $($candidates.Count)"
Write-Output "archive: $targetRoot"
Write-Output "summary: $summaryPath"
