$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

$suiteRoot = Get-SuiteRoot
$userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)

$targets = @(
    [pscustomobject]@{
        Name = 'suite source'
        Role = 'primary source; edit here by default'
        Path = $suiteRoot
        Marker = 'suite.manifest.json'
    },
    [pscustomobject]@{
        Name = 'live runtime skill'
        Role = 'runtime copy generated from suite'
        Path = (Join-Path $userHome '.codex\skills\claude-to-im')
        Marker = 'SKILL.md'
    },
    [pscustomobject]@{
        Name = 'live core skill'
        Role = 'runtime copy generated from suite'
        Path = (Join-Path $userHome '.codex\skills\claude-to-im-core')
        Marker = 'package.json'
    },
    [pscustomobject]@{
        Name = 'portable artifact'
        Role = 'generated artifact; not a source entry'
        Path = (Join-Path $suiteRoot 'release\portable')
        Marker = 'suite.manifest.json'
    },
    [pscustomobject]@{
        Name = 'installer artifact'
        Role = 'generated artifact; not a source entry'
        Path = (Join-Path $suiteRoot 'release\installer')
        Marker = 'payload\suite.manifest.json'
    }
)

function Get-PathSummary {
    param($Target)

    $exists = Test-Path -LiteralPath $Target.Path
    $markerPath = Join-Path $Target.Path $Target.Marker
    $markerExists = Test-Path -LiteralPath $markerPath
    $mtime = if ($exists) { (Get-Item -LiteralPath $Target.Path).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '-' }

    [pscustomobject]@{
        Name = $Target.Name
        Role = $Target.Role
        Exists = $exists
        Marker = $markerExists
        Modified = $mtime
        Path = $Target.Path
    }
}

function Get-HashText {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return '<missing>'
    }

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Substring(0, 12)
}

function Compare-FileHash {
    param(
        [string]$Label,
        [string]$Left,
        [string]$Right,
        [string]$LeftName = 'suite',
        [string]$RightName = 'other'
    )

    $leftHash = Get-HashText -Path $Left
    $rightHash = Get-HashText -Path $Right
    $status = if ($leftHash -eq '<missing>' -or $rightHash -eq '<missing>') {
        'missing'
    } elseif ($leftHash -eq $rightHash) {
        'same'
    } else {
        'diff'
    }

    [pscustomobject]@{
        Check = $Label
        Status = $status
        SuiteHash = "$LeftName=$leftHash"
        OtherHash = "$RightName=$rightHash"
    }
}

Write-Host 'codex-im-suite target doctor'
Write-Host "Suite root: $suiteRoot"
Write-Host ''
Write-Host 'Path roles:'
$targets | ForEach-Object { Get-PathSummary -Target $_ } | Format-Table -AutoSize | Out-String | Write-Host

$liveRuntime = Join-Path $userHome '.codex\skills\claude-to-im'
$liveCore = Join-Path $userHome '.codex\skills\claude-to-im-core'

$checks = @()
$checks += Compare-FileHash -Label 'bridge-runtime src/main.ts' `
    -Left (Join-Path $suiteRoot 'packages\bridge-runtime\src\main.ts') `
    -Right (Join-Path $liveRuntime 'src\main.ts') `
    -RightName 'live'
$checks += Compare-FileHash -Label 'bridge-core bridge-manager.ts' `
    -Left (Join-Path $suiteRoot 'packages\bridge-core\src\lib\bridge\bridge-manager.ts') `
    -Right (Join-Path $liveCore 'src\lib\bridge\bridge-manager.ts') `
    -RightName 'live'
$legacyLiveTools = Join-Path $liveRuntime 'tools'
$checks += [pscustomobject]@{
    Check = 'legacy live runtime tools'
    Status = if (Test-Path -LiteralPath $legacyLiveTools) { 'present-remove-on-sync' } else { 'removed' }
    SuiteHash = 'expected=removed'
    OtherHash = "path=$legacyLiveTools"
}
$legacyControlPanel = Join-Path $suiteRoot 'packages\bridge-runtime\tools\ControlPanel'
$legacyInstaller = Join-Path $suiteRoot 'packages\bridge-runtime\tools\Installer'
$checks += [pscustomobject]@{
    Check = 'legacy bridge-runtime tools/ControlPanel'
    Status = if (Test-Path -LiteralPath $legacyControlPanel) { 'present-remove' } else { 'removed' }
    SuiteHash = 'expected=removed'
    OtherHash = "path=$legacyControlPanel"
}
$checks += [pscustomobject]@{
    Check = 'legacy bridge-runtime tools/Installer'
    Status = if (Test-Path -LiteralPath $legacyInstaller) { 'present-remove' } else { 'removed' }
    SuiteHash = 'expected=removed'
    OtherHash = "path=$legacyInstaller"
}
$powershellUtf8ProfileScript = Join-Path $PSScriptRoot 'windows-powershell-utf8-profile.ps1'
$powershellUtf8Output = (& $powershellUtf8ProfileScript -Mode Check 2>&1 | Out-String).Trim()
$powershellUtf8ExitCode = $LASTEXITCODE
$checks += [pscustomobject]@{
    Check = 'powershell-utf8'
    Status = if ($powershellUtf8ExitCode -eq 0) { 'healthy' } else { 'failed' }
    SuiteHash = if ($powershellUtf8ExitCode -eq 0) { 'stdin=utf8' } else { 'stdin=unsafe' }
    OtherHash = if ($powershellUtf8ExitCode -eq 0) {
        $powershellUtf8Output
    } else {
        "repair=powershell -ExecutionPolicy Bypass -File `"$powershellUtf8ProfileScript`" -Mode Apply"
    }
}

Write-Host 'Key file checks:'
$checks | Format-Table -AutoSize | Out-String | Write-Host

$suitePanelExe = Join-Path $suiteRoot 'release\artifacts\control-panel\CodexImSuiteControlPanel.exe'
$portablePanelExe = Join-Path $suiteRoot 'release\portable\CodexImSuiteControlPanel.exe'
$livePanelExe = Join-Path $liveRuntime 'dist\control-panel\CodexImSuiteControlPanel.exe'
$legacyLivePanelExe = Join-Path $liveRuntime 'dist\control-panel\ClaudeToImControlPanel.exe'

Write-Host 'Panel executables:'
foreach ($path in @($suitePanelExe, $portablePanelExe, $livePanelExe)) {
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path
        Write-Host ("  {0} | {1} bytes | {2}" -f $item.FullName, $item.Length, $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    } else {
        Write-Host "  <missing> $path"
    }
}
if (Test-Path -LiteralPath $legacyLivePanelExe) {
    Write-Host "  legacy-compatible entry present; remove after switching shortcuts: $legacyLivePanelExe"
}

Write-Host ''
Write-Host 'Maintenance rule: edit apps/control-panel for panel work; legacy packages/bridge-runtime/tools was removed.'
Write-Host 'Maintenance rule: edit suite packages/config/scripts/docs first; live skills and release directories are generated or runtime copies.'
