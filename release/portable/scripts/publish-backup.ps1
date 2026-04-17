$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$suiteRoot = Split-Path -Parent $scriptDir
$publishSummaryPath = Join-Path $suiteRoot 'publish-summary.md'
$releaseNotesPath = Join-Path $suiteRoot 'release-notes.md'
$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$configPath = Join-Path $ctiHome 'config.env'

function Get-ConfigMap {
    param([string]$Path)

    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $map
    }

    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
        $idx = $trimmed.IndexOf('=')
        $key = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
        $map[$key] = $value
    }

    return $map
}

function Get-ChangedLines {
    Push-Location $suiteRoot
    try {
        return @(git status --short)
    }
    finally {
        Pop-Location
    }
}

function Get-DiffSnippet {
    Push-Location $suiteRoot
    try {
        $diff = @(git diff --no-color -- .) -join [Environment]::NewLine
        if ([string]::IsNullOrWhiteSpace($diff)) {
            return ''
        }
        $maxChars = 18000
        if ($diff.Length -le $maxChars) {
            return $diff
        }
        return $diff.Substring(0, $maxChars) + "`n...<truncated>"
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
            SummarySource = 'fallback-empty'
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
        SummarySource = 'fallback-rule'
    }
}

function ConvertTo-StringArray {
    param($Value)

    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value | ForEach-Object { [string]$_ }) }
    if ($Value -is [string]) {
        return @($Value -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    return @([string]$Value)
}

function Try-ConvertFrom-JsonObject {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $trimmed = $Text.Trim()
    try {
        return $trimmed | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        $match = [regex]::Match($trimmed, '\{[\s\S]*\}')
        if (-not $match.Success) { return $null }
        try {
            return $match.Value | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            return $null
        }
    }
}

function Try-GetLocalAiSummary {
    param(
        [string[]]$Lines,
        [string]$DiffSnippet,
        $FallbackSummary
    )

    $config = Get-ConfigMap -Path $configPath
    $localEnabled = if ($config.ContainsKey('CTI_LOCAL_LLM_ENABLED')) { [string]$config['CTI_LOCAL_LLM_ENABLED'] } else { 'true' }
    if ($localEnabled.ToLowerInvariant() -eq 'false') {
        return $null
    }

    $baseUrl = if ($config.ContainsKey('CTI_LOCAL_LLM_BASE_URL')) { $config['CTI_LOCAL_LLM_BASE_URL'] } else { 'http://127.0.0.1:8080' }
    $model = if ($config.ContainsKey('CTI_LOCAL_LLM_MODEL')) { $config['CTI_LOCAL_LLM_MODEL'] } else { 'qwen2.5-coder-7b-instruct' }

    $statusLines = ($Lines | Select-Object -First 80) -join "`n"
    $fallbackPreview = [string]$FallbackSummary.Preview
    $fallbackBody = [string]$FallbackSummary.Body
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

    $systemPrompt = @'
You summarize software release changes for git commits.
Return strict JSON only.
Schema:
{
  "subject": "short commit subject",
  "preview": ["line 1", "line 2"],
  "body": ["section or bullet line 1", "section or bullet line 2"]
}
Rules:
- Keep subject short and specific.
- Do not mention timestamps.
- Preview should be 3-8 lines.
- Body should be concise and grouped by real change areas.
- Focus on actual engineering changes, not generic wording.
- ASCII only.
'@

    $userPrompt = @"
Summarize this pending publish.

Changed files:
$statusLines

Diff snippet:
$DiffSnippet

Fallback preview:
$fallbackPreview

Fallback body:
$fallbackBody
"@

    $payload = @{
        model = $model
        temperature = 0.2
        max_tokens = 450
        messages = @(
            @{ role = 'system'; content = $systemPrompt },
            @{ role = 'user'; content = $userPrompt }
        )
    } | ConvertTo-Json -Depth 6 -Compress

    try {
        $response = Invoke-RestMethod -Method Post -Uri ($baseUrl.TrimEnd('/') + '/v1/chat/completions') -ContentType 'application/json' -Body $payload -TimeoutSec 20
        $content = [string]$response.choices[0].message.content
        $json = Try-ConvertFrom-JsonObject -Text $content
        if ($null -eq $json) { return $null }

        $subject = [string]$json.subject
        $previewLines = ConvertTo-StringArray $json.preview
        $bodyLines = ConvertTo-StringArray $json.body

        if ([string]::IsNullOrWhiteSpace($subject)) { return $null }
        if ($previewLines.Count -eq 0) { return $null }

        return [pscustomobject]@{
            Timestamp = $timestamp
            Subject = $subject.Trim()
            Body = ($bodyLines -join [Environment]::NewLine).Trim()
            Preview = ($previewLines -join [Environment]::NewLine).Trim()
            McpLines = $FallbackSummary.McpLines
            PanelLines = $FallbackSummary.PanelLines
            OtherLines = $FallbackSummary.OtherLines
            SummarySource = 'local-llm'
        }
    }
    catch {
        return $null
    }
}

function Write-PublishSummaryFiles {
    param($Summary)

    $latest = New-Object System.Collections.Generic.List[string]
    $latest.Add('# Publish Summary')
    $latest.Add('')
    $latest.Add("- Time: $($Summary.Timestamp)")
    $latest.Add("- Subject: $($Summary.Subject)")
    $latest.Add("- Summary source: $($Summary.SummarySource)")
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
    $entry.Add("- Summary source: $($Summary.SummarySource)")
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
    $fallbackSummary = Get-PublishSummary -Lines $changedBeforeAdd
    $diffSnippet = Get-DiffSnippet
    $summary = Try-GetLocalAiSummary -Lines $changedBeforeAdd -DiffSnippet $diffSnippet -FallbackSummary $fallbackSummary
    if ($null -eq $summary) {
        $summary = $fallbackSummary
    }

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
