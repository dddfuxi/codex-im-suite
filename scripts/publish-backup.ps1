$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$publishSummaryPath = Join-Path $suiteRoot 'publish-summary.md'
$releaseNotesPath = Join-Path $suiteRoot 'release-notes.md'

function Get-ChangedLines {
    Push-Location $suiteRoot
    try {
        return @(git status --short)
    }
    finally {
        Pop-Location
    }
}

function Get-PublishSummary {
    param([string[]]$Lines)

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

    if (-not $Lines -or $Lines.Count -eq 0) {
        return [pscustomobject]@{
            Timestamp = $timestamp
            Subject = "backup suite snapshot $timestamp"
            Body = "No local changes detected."
            Preview = "No pending changes were detected."
            McpLines = @()
            PanelLines = @()
            OtherLines = @()
        }
    }

    $mcpLines = @($Lines | Where-Object { $_ -match 'config[\\/]+mcp\.d[\\/].+\.json|scripts[\\/]+(launch|stop)-.+-mcp\.ps1|extensions[\\/]+blender|packages[\\/]+mcp-' })
    $panelLines = @($Lines | Where-Object { $_ -match 'apps[\\/]+control-panel[\\/]|packages[\\/]+bridge-runtime[\\/]+scripts[\\/]+build-control-panel\.ps1|scripts[\\/]+sync-live-skill\.ps1' })
    $otherLines = @($Lines | Where-Object { $mcpLines -notcontains $_ -and $panelLines -notcontains $_ })

    $subjectParts = New-Object System.Collections.Generic.List[string]
    if ($mcpLines.Count -gt 0) { $subjectParts.Add('update MCPs') }
    if ($panelLines.Count -gt 0) { $subjectParts.Add('refresh panel') }
    if ($otherLines.Count -gt 0) { $subjectParts.Add('sync suite') }
    if ($subjectParts.Count -eq 0) { $subjectParts.Add('backup suite snapshot') }
    $subject = ($subjectParts -join '; ') + " $timestamp"

    $bodyLines = New-Object System.Collections.Generic.List[string]
    if ($mcpLines.Count -gt 0) {
        $bodyLines.Add('MCP changes:')
        $mcpLines | ForEach-Object { $bodyLines.Add('- ' + $_.Trim()) }
    }
    if ($panelLines.Count -gt 0) {
        $bodyLines.Add('')
        $bodyLines.Add('Control panel changes:')
        $panelLines | ForEach-Object { $bodyLines.Add('- ' + $_.Trim()) }
    }
    if ($otherLines.Count -gt 0) {
        $bodyLines.Add('')
        $bodyLines.Add('Other suite changes:')
        $otherLines | Select-Object -First 20 | ForEach-Object { $bodyLines.Add('- ' + $_.Trim()) }
        if ($otherLines.Count -gt 20) {
            $bodyLines.Add("- ... and $($otherLines.Count - 20) more")
        }
    }

    $previewLines = New-Object System.Collections.Generic.List[string]
    if ($mcpLines.Count -gt 0) {
        $previewLines.Add('MCP changes:')
        $mcpLines | Select-Object -First 12 | ForEach-Object { $previewLines.Add('- ' + $_.Trim()) }
        if ($mcpLines.Count -gt 12) { $previewLines.Add("- ... and $($mcpLines.Count - 12) more") }
    } else {
        $previewLines.Add('MCP changes: none')
    }
    if ($panelLines.Count -gt 0) {
        $previewLines.Add('')
        $previewLines.Add('Control panel changes:')
        $panelLines | Select-Object -First 8 | ForEach-Object { $previewLines.Add('- ' + $_.Trim()) }
        if ($panelLines.Count -gt 8) { $previewLines.Add("- ... and $($panelLines.Count - 8) more") }
    }
    if ($otherLines.Count -gt 0) {
        $previewLines.Add('')
        $previewLines.Add('Other changes:')
        $otherLines | Select-Object -First 8 | ForEach-Object { $previewLines.Add('- ' + $_.Trim()) }
        if ($otherLines.Count -gt 8) { $previewLines.Add("- ... and $($otherLines.Count - 8) more") }
    }

    return [pscustomobject]@{
        Timestamp = $timestamp
        Subject = $subject
        Body = ($bodyLines -join [Environment]::NewLine).Trim()
        Preview = ($previewLines -join [Environment]::NewLine).Trim()
        McpLines = $mcpLines
        PanelLines = $panelLines
        OtherLines = $otherLines
    }
}

function Write-PublishSummaryFiles {
    param($Summary)

    $latest = New-Object System.Collections.Generic.List[string]
    $latest.Add('# Publish Summary')
    $latest.Add('')
    $latest.Add("- Time: $($Summary.Timestamp)")
    $latest.Add("- Subject: $($Summary.Subject)")
    $latest.Add('')
    $latest.Add('## Preview')
    $latest.Add('')
    foreach ($line in ($Summary.Preview -split "\r?\n")) {
        $latest.Add([string]$line)
    }
    if (-not [string]::IsNullOrWhiteSpace($Summary.Body)) {
        $latest.Add('')
        $latest.Add('## Commit Body')
        $latest.Add('')
        foreach ($line in ($Summary.Body -split "\r?\n")) {
            $latest.Add([string]$line)
        }
    }
    Set-Content -LiteralPath $publishSummaryPath -Value $latest -Encoding UTF8

    $entry = New-Object System.Collections.Generic.List[string]
    $entry.Add("## $($Summary.Timestamp)")
    $entry.Add('')
    $entry.Add("- Subject: $($Summary.Subject)")
    $entry.Add('')
    $entry.Add('### Preview')
    $entry.Add('')
    foreach ($line in ($Summary.Preview -split "\r?\n")) {
        $entry.Add([string]$line)
    }
    if (-not [string]::IsNullOrWhiteSpace($Summary.Body)) {
        $entry.Add('')
        $entry.Add('### Commit Body')
        $entry.Add('')
        foreach ($line in ($Summary.Body -split "\r?\n")) {
            $entry.Add([string]$line)
        }
    }
    $entryText = ($entry -join [Environment]::NewLine).TrimEnd()

    if (Test-Path -LiteralPath $releaseNotesPath) {
        $existing = Get-Content -LiteralPath $releaseNotesPath -Raw -Encoding UTF8
        $combined = "# Release Notes`r`n`r`n$entryText`r`n`r`n$($existing -replace '^\# Release Notes\r?\n\r?\n', '')"
        Set-Content -LiteralPath $releaseNotesPath -Value $combined -Encoding UTF8
    } else {
        $initial = "# Release Notes`r`n`r`n$entryText`r`n"
        Set-Content -LiteralPath $releaseNotesPath -Value $initial -Encoding UTF8
    }
}

& (Join-Path $scriptDir 'sync-live-skill.ps1')
& (Join-Path $scriptDir 'package-release.ps1')

Push-Location $suiteRoot
try {
    $changedBeforeAdd = Get-ChangedLines
    $summary = Get-PublishSummary -Lines $changedBeforeAdd
    Write-Host 'Publish summary:'
    Write-Host $summary.Preview
    Write-Host '---'

    Write-PublishSummaryFiles -Summary $summary

    git add .
    if (-not (git diff --cached --quiet)) {
        if ([string]::IsNullOrWhiteSpace($summary.Body)) {
            git commit -m $summary.Subject
        } else {
            git commit -m $summary.Subject -m $summary.Body
        }
    }
    git push
}
finally {
    Pop-Location
}
