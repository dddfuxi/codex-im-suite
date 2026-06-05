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

function New-EncodingToken {
    param([int[]]$CodePoints)
    return -join ($CodePoints | ForEach-Object { [char]$_ })
}

function Remove-EncodingAllowedBlocks {
    param([string]$Text)
    $startMarker = 'cti-encoding-allow-start'
    $endMarker = 'cti-encoding-allow-end'
    $result = New-Object System.Text.StringBuilder
    $cursor = 0
    while ($cursor -lt $Text.Length) {
        $start = $Text.IndexOf($startMarker, $cursor, [StringComparison]::Ordinal)
        if ($start -lt 0) {
            [void]$result.Append($Text.Substring($cursor))
            break
        }
        [void]$result.Append($Text.Substring($cursor, $start - $cursor))
        $end = $Text.IndexOf($endMarker, $start + $startMarker.Length, [StringComparison]::Ordinal)
        if ($end -lt 0) {
            [void]$result.Append($Text.Substring($start))
            break
        }
        $cursor = $end + $endMarker.Length
    }
    return $result.ToString()
}

function Test-SourceEncodingIssue {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return $true
    }

    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $text = Remove-EncodingAllowedBlocks -Text $text
    if ($text.Contains([string][char]0xFFFD)) { return $true }
    if ($text -match '\?{6,}') { return $true }
    if ($text -match '\bif\s*\(\s*false\s*&&') { return $true }

    $tokens = @(
        (New-EncodingToken @(0x9365, 0x73AA)),
        (New-EncodingToken @(0x9358, 0x56E7)),
        (New-EncodingToken @(0x934F, 0x5CF0)),
        (New-EncodingToken @(0x9359, 0x6A3A)),
        (New-EncodingToken @(0x93C8, 0x612C)),
        (New-EncodingToken @(0x95C6, 0x6A40)),
        (New-EncodingToken @(0x7039, 0x744C)),
        (New-EncodingToken @(0x9428, 0x52EC)),
        (New-EncodingToken @(0x6D93, 0xE15F)),
        (New-EncodingToken @(0x6D93, 0x581D)),
        (New-EncodingToken @(0x6D93, 0x5D88)),
        (New-EncodingToken @(0x9365)),
        (New-EncodingToken @(0x93C4)),
        (New-EncodingToken @(0x951B)),
        (New-EncodingToken @(0x00C3)),
        (New-EncodingToken @(0x00C2)),
        (New-EncodingToken @(0x00E2, 0x20AC))
    )
    foreach ($token in $tokens) {
        if ($text.Contains($token)) { return $true }
    }
    return $false
}

function Get-SourceEncodingScanFiles {
    $roots = @(
        (Join-Path $suiteRoot 'packages\bridge-core\src\lib'),
        (Join-Path $suiteRoot 'packages\bridge-runtime\src'),
        (Join-Path $suiteRoot 'apps\control-panel'),
        (Join-Path $suiteRoot 'scripts')
    )
    $extensions = @('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cs', '.ps1', '.md', '.json')
    $excludedDirs = @('__tests__', 'dist', 'node_modules', 'bin', 'obj', 'release', '.git', '.cti-index')
    $files = New-Object System.Collections.Generic.List[string]
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
            $relativeParts = $_.FullName.Substring($root.Length).TrimStart('\') -split '[\\/]'
            if ($relativeParts | Where-Object { $excludedDirs -contains $_ }) { return }
            if ($extensions -contains $_.Extension.ToLowerInvariant()) {
                [void]$files.Add($_.FullName)
            }
        }
    }
    return $files
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
$sourceEncodingFiles = @()
foreach ($path in Get-SourceEncodingScanFiles) {
    if (Test-SourceEncodingIssue -Path $path) {
        $sourceEncodingFiles += $path
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
if ($sourceEncodingFiles.Count -gt 0) {
    Write-Host ''
    Write-Host 'Source encoding scan: FAILED'
    $sourceEncodingFiles | ForEach-Object { Write-Host "  $_" }
    exit 2
}

Write-Host 'Source encoding scan: OK'
Write-Host 'Done.'
