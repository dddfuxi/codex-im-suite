param(
    [ValidateSet('BackupPublish', 'MainPreflight')]
    [string]$Mode = 'BackupPublish',
    [switch]$FailOnFork
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$manifest = Get-SuiteManifest -SuiteRoot $suiteRoot
$userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$releaseRunId = if ($env:CTI_RELEASE_RUN_ID) { $env:CTI_RELEASE_RUN_ID } else { '' }

function New-CheckResult {
    param(
        [string]$Target,
        [string]$Component,
        [string]$Status,
        [string]$Expected,
        [string]$Actual
    )

    return [pscustomobject]@{
        Target = $Target
        Component = $Component
        Status = $Status
        Expected = $Expected
        Actual = $Actual
    }
}

function Compare-ContentMap {
    param(
        [string]$TargetName,
        [hashtable]$Expected,
        [hashtable]$Actual
    )

    $results = New-Object System.Collections.Generic.List[object]
    foreach ($key in $Expected.Keys) {
        $expectedValue = [string]$Expected[$key]
        $actualValue = if ($Actual.Contains($key)) { [string]$Actual[$key] } else { '<missing>' }
        $status = if ($expectedValue -eq '<missing>' -or $actualValue -eq '<missing>') {
            'missing'
        } elseif ($expectedValue -eq $actualValue) {
            'same'
        } else {
            'diff'
        }
        $results.Add((New-CheckResult -Target $TargetName -Component $key -Status $status -Expected $expectedValue -Actual $actualValue)) | Out-Null
    }
    return $results.ToArray()
}

function Test-Fingerprint {
    param(
        [string]$TargetName,
        [string]$TargetRoot,
        [string]$ExpectedRunId
    )

    $fingerprint = Read-SuiteReleaseFingerprint -TargetRoot $TargetRoot
    if ($null -eq $fingerprint) {
        return @(New-CheckResult -Target $TargetName -Component '.suite-release.json' -Status 'missing' -Expected 'present' -Actual '<missing>')
    }

    $results = New-Object System.Collections.Generic.List[object]
    $schema = [string]$fingerprint.schema
    $schemaStatus = if ($schema -eq 'codex-im-suite/release-fingerprint/v1') { 'same' } else { 'diff' }
    $results.Add((New-CheckResult -Target $TargetName -Component 'fingerprint.schema' -Status $schemaStatus -Expected 'codex-im-suite/release-fingerprint/v1' -Actual $schema)) | Out-Null

    if (-not [string]::IsNullOrWhiteSpace($ExpectedRunId)) {
        $runId = [string]$fingerprint.releaseRunId
        $runStatus = if ($runId -eq $ExpectedRunId) { 'same' } else { 'diff' }
        $results.Add((New-CheckResult -Target $TargetName -Component 'fingerprint.releaseRunId' -Status $runStatus -Expected $ExpectedRunId -Actual $runId)) | Out-Null
    }

    $version = [string]$fingerprint.suite.version
    $versionStatus = if ($version -eq [string]$manifest.version) { 'same' } else { 'diff' }
    $results.Add((New-CheckResult -Target $TargetName -Component 'fingerprint.suiteVersion' -Status $versionStatus -Expected ([string]$manifest.version) -Actual $version)) | Out-Null
    return $results.ToArray()
}

function Add-TargetChecks {
    param(
        [System.Collections.Generic.List[object]]$AllResults,
        [string]$TargetName,
        [string]$TargetRoot,
        [ValidateSet('LiveRuntime', 'LiveCore', 'Portable', 'InstallerPayload')]
        [string]$Layout
    )

    if (-not (Test-Path -LiteralPath $TargetRoot)) {
        $AllResults.Add((New-CheckResult -Target $TargetName -Component 'target.path' -Status 'missing' -Expected 'present' -Actual $TargetRoot)) | Out-Null
        return
    }

    $expected = Get-SuiteReleaseExpectedContentMap -SuiteRoot $suiteRoot -Layout $Layout
    $actual = Get-SuiteReleaseActualContentMap -SuiteRoot $suiteRoot -TargetRoot $TargetRoot -Layout $Layout
    Compare-ContentMap -TargetName $TargetName -Expected $expected -Actual $actual | ForEach-Object { $AllResults.Add($_) | Out-Null }
    Test-Fingerprint -TargetName $TargetName -TargetRoot $TargetRoot -ExpectedRunId $releaseRunId | ForEach-Object { $AllResults.Add($_) | Out-Null }
}

$branch = (Get-GitText -SuiteRoot $suiteRoot -GitArgs @('branch', '--show-current')).Trim()
$commit = (Get-GitText -SuiteRoot $suiteRoot -GitArgs @('rev-parse', '--short', 'HEAD')).Trim()
$dirtyLines = @((Get-GitText -SuiteRoot $suiteRoot -GitArgs @('status', '--short')) -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$sourceManifestSummary = Get-ReleaseManifestSummary -Root $suiteRoot
$sourcePanelRoot = if ($env:CTI_RELEASE_CONTROL_PANEL_DIR) { $env:CTI_RELEASE_CONTROL_PANEL_DIR } else { Join-Path $suiteRoot 'release\artifacts\control-panel' }
$sourcePanel = Get-ReleasePanelSummary -Path (Join-Path $sourcePanelRoot 'CodexImSuiteControlPanel.exe')

Write-Host 'Release fork health check'
Write-Host "Mode: $Mode"
Write-Host "Suite root: $suiteRoot"
Write-Host "Suite version: $($manifest.version)"
Write-Host "Extension protocol: $($manifest.extensionProtocol.id)"
Write-Host "Branch: $branch"
Write-Host "Commit: $commit"
Write-Host "Dirty: $($dirtyLines.Count -gt 0)"
if (-not [string]::IsNullOrWhiteSpace($releaseRunId)) {
    Write-Host "Release run id: $releaseRunId"
}
Write-Host "Manifest files: $($sourceManifestSummary.Count) | hash=$($sourceManifestSummary.Hash)"
Write-Host "Control panel: exists=$($sourcePanel.Exists) | hash=$($sourcePanel.Hash) | modified=$($sourcePanel.Modified)"
Write-Host ''

$results = New-Object System.Collections.Generic.List[object]

if ($Mode -eq 'BackupPublish') {
    Add-TargetChecks -AllResults $results -TargetName 'live runtime skill' -TargetRoot (Join-Path $userHome '.codex\skills\claude-to-im') -Layout 'LiveRuntime'
    Add-TargetChecks -AllResults $results -TargetName 'live core skill' -TargetRoot (Join-Path $userHome '.codex\skills\claude-to-im-core') -Layout 'LiveCore'
} else {
    Write-Host 'Live skill: skipped by main release preflight policy'
    Write-Host ''
}

Add-TargetChecks -AllResults $results -TargetName 'portable artifact' -TargetRoot (Join-Path $suiteRoot 'release\portable') -Layout 'Portable'
Add-TargetChecks -AllResults $results -TargetName 'installer payload' -TargetRoot (Join-Path $suiteRoot 'release\installer\payload') -Layout 'InstallerPayload'

$results | Sort-Object Target, Component | Format-Table -AutoSize | Out-String | Write-Host

$bad = @($results | Where-Object { $_.Status -ne 'same' })
if ($bad.Count -gt 0) {
    Write-Host "Release fork health: FAILED ($($bad.Count) mismatches)"
    if ($FailOnFork) {
        exit 1
    }
} else {
    Write-Host 'Release fork health: PASS'
}
