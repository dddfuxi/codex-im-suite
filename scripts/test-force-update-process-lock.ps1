$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'shared.ps1')

function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function New-TestProcessInRoot {
    param([string]$Root)

    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $exePath = Join-Path $Root 'CodexImSuiteControlPanel.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Destination $exePath -Force
    return Start-Process -FilePath $exePath -ArgumentList @('-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
}

function Wait-ForProcessPath {
    param(
        [int]$ProcessId,
        [string]$ExpectedPath
    )

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -ne $process) {
            try {
                if ([string]::Equals([System.IO.Path]::GetFullPath($process.Path), [System.IO.Path]::GetFullPath($ExpectedPath), [System.StringComparison]::OrdinalIgnoreCase)) {
                    return
                }
            }
            catch {
            }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out waiting for test process path: $ExpectedPath"
}

function Stop-TestProcess {
    param([System.Diagnostics.Process]$Process)

    if ($null -eq $Process) { return }
    if (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

$testRoot = Join-Path $env:TEMP ("cti-force-update-test-" + [guid]::NewGuid().ToString('N'))
$forceRoot = Join-Path $testRoot 'force'
$noForceRoot = Join-Path $testRoot 'noforce'
$lockedRoot = Join-Path $testRoot 'locked-delete'
$forceProcess = $null
$noForceProcess = $null
$lockProcess = $null
$previousForceSetting = $env:CTI_RELEASE_FORCE_UPDATE

try {
    $forceProcess = New-TestProcessInRoot -Root $forceRoot
    Wait-ForProcessPath -ProcessId $forceProcess.Id -ExpectedPath (Join-Path $forceRoot 'CodexImSuiteControlPanel.exe')
    Clear-RunningProcessInPathForUpdate -Roots @($forceRoot) -Purpose 'test force update' -TimeoutSeconds 10
    Assert-Condition -Condition (-not (Get-Process -Id $forceProcess.Id -ErrorAction SilentlyContinue)) -Message 'force update did not stop the target process'

    $env:CTI_RELEASE_FORCE_UPDATE = 'false'
    $noForceProcess = New-TestProcessInRoot -Root $noForceRoot
    Wait-ForProcessPath -ProcessId $noForceProcess.Id -ExpectedPath (Join-Path $noForceRoot 'CodexImSuiteControlPanel.exe')
    $blocked = $false
    try {
        Clear-RunningProcessInPathForUpdate -Roots @($noForceRoot) -Purpose 'test no force update' -TimeoutSeconds 10
    }
    catch {
        $blocked = $true
    }
    Assert-Condition -Condition $blocked -Message 'CTI_RELEASE_FORCE_UPDATE=false should block instead of killing'
    Assert-Condition -Condition ($null -ne (Get-Process -Id $noForceProcess.Id -ErrorAction SilentlyContinue)) -Message 'no-force mode unexpectedly stopped the target process'

    New-Item -ItemType Directory -Force -Path $lockedRoot | Out-Null
    $lockedFile = Join-Path $lockedRoot 'CodexImSuiteControlPanel.exe'
    Set-Content -LiteralPath $lockedFile -Value 'locked' -Encoding UTF8
    $lockScript = '$stream=[System.IO.File]::Open($args[0],[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); Start-Sleep -Seconds 2; $stream.Dispose()'
    $lockProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoLogo', '-NoProfile', '-Command', $lockScript, $lockedFile) -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 300
    Remove-PathForUpdate -Path $lockedRoot -Purpose 'test retry remove' -RetryCount 20 -DelayMilliseconds 250
    Assert-Condition -Condition (-not (Test-Path -LiteralPath $lockedRoot)) -Message 'retry remove did not delete the locked directory after the handle was released'
}
finally {
    if ($null -eq $previousForceSetting) {
        Remove-Item Env:\CTI_RELEASE_FORCE_UPDATE -ErrorAction SilentlyContinue
    }
    else {
        $env:CTI_RELEASE_FORCE_UPDATE = $previousForceSetting
    }
    Stop-TestProcess -Process $forceProcess
    Stop-TestProcess -Process $noForceProcess
    Stop-TestProcess -Process $lockProcess
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'force update process lock tests passed'
