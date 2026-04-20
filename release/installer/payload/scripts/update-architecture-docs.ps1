$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$architectureDoc = Join-Path $suiteRoot 'docs\PROJECT-ARCHITECTURE.md'
$developmentLog = Join-Path $suiteRoot 'docs\DEVELOPMENT-LOG.md'
$agentsFile = Join-Path $suiteRoot 'AGENTS.md'
$skillFile = Join-Path $suiteRoot 'extensions\skills\project-architecture-diagram\SKILL.md'
$checklistFile = Join-Path $suiteRoot 'extensions\skills\project-architecture-diagram\references\maintenance-checklist.md'

function Test-File {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Name not found: $Path"
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

function Test-ArchitectureRelevantChange {
    param([string[]]$Lines)

    $patterns = @(
        'packages[\\/]+bridge-core[\\/]+src',
        'packages[\\/]+bridge-runtime[\\/]+src',
        'apps[\\/]+control-panel',
        'config[\\/]+mcp\.d',
        'config[\\/]+skills\.d',
        'config[\\/]+plugins\.d',
        'scripts[\\/]+(build|assemble|package|publish|sync|register|bootstrap)',
        'suite\.manifest\.json',
        'AGENTS\.md'
    )

    foreach ($line in $Lines) {
        foreach ($pattern in $patterns) {
            if ($line -match $pattern) {
                return $true
            }
        }
    }
    return $false
}

function Test-Mojibake {
    param([string]$Path)
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $badChars = @(
        [char]0xFFFD,
        [char]0x951B,
        [char]0x9359,
        [char]0x93C4,
        [char]0x7ECB,
        [char]0x5997,
        [char]0x4E36,
        [char]0x7039
    )
    foreach ($char in $badChars) {
        if ($text.Contains([string]$char)) { return $true }
    }
    return $false
}

Test-File -Path $architectureDoc -Name 'Architecture doc'
Test-File -Path $developmentLog -Name 'Development log'
Test-File -Path $agentsFile -Name 'Agent rules'
Test-File -Path $skillFile -Name 'project-architecture-diagram skill'
Test-File -Path $checklistFile -Name 'Architecture maintenance checklist'

$statusLines = Get-GitStatusLines
$needsArchitectureReview = Test-ArchitectureRelevantChange -Lines $statusLines
$mojibakeFiles = @()
foreach ($path in @($architectureDoc, $developmentLog, $agentsFile, $skillFile, $checklistFile)) {
    if (Test-Mojibake -Path $path) {
        $mojibakeFiles += $path
    }
}

Write-Host 'Architecture documentation maintenance check'
Write-Host "Suite root: $suiteRoot"
Write-Host "Architecture doc: $architectureDoc"
Write-Host "Skill: $skillFile"
Write-Host ''

if ($statusLines.Count -gt 0) {
    Write-Host 'Pending changes:'
    $statusLines | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host 'Pending changes: none'
}

Write-Host ''
if ($needsArchitectureReview) {
    Write-Host 'Architecture review: REQUIRED'
    Write-Host 'Use the project-architecture-diagram skill and update docs/PROJECT-ARCHITECTURE.md if the current change affects module boundaries, runtime flow, data flow, MCP, provider routing, packaging, or public interfaces.'
} else {
    Write-Host 'Architecture review: probably not required'
}

if ($mojibakeFiles.Count -gt 0) {
    Write-Host ''
    Write-Host 'Mojibake scan: FAILED'
    $mojibakeFiles | ForEach-Object { Write-Host "  $_" }
    exit 2
}

Write-Host ''
Write-Host 'Mojibake scan: OK'
Write-Host 'Done.'
