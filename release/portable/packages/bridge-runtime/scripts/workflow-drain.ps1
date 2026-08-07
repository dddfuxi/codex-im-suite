param(
    [string]$StatusPath = '',
    [Nullable[int]]$TimeoutMs = $null,
    [Nullable[int]]$PollMs = $null,
    [switch]$Force
)

$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-ConfigEnvValue {
    param([string]$ConfigPath, [string]$Name)
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
    $line = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 |
        ForEach-Object { ([string]$_).TrimStart([char]0xFEFF) } |
        Where-Object { $_ -match ('^\s*' + [Regex]::Escape($Name) + '\s*=') } |
        Select-Object -Last 1
    if (-not $line) { return $null }
    return (($line -split '=', 2)[1]).Trim()
}

function Convert-ToPositiveInt {
    param([object]$Value, [int]$Fallback, [int]$Minimum, [int]$Maximum)
    $parsed = 0
    if (-not [int]::TryParse([string]$Value, [ref]$parsed)) { return $Fallback }
    return [Math]::Max($Minimum, [Math]::Min($Maximum, $parsed))
}

$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$configPath = Join-Path $ctiHome 'config.env'
if (-not $StatusPath) { $StatusPath = Join-Path $ctiHome 'runtime\workflow-runs.json' }

$fileTimeout = Get-ConfigEnvValue -ConfigPath $configPath -Name 'CTI_WORKFLOW_DRAIN_TIMEOUT_MS'
$filePoll = Get-ConfigEnvValue -ConfigPath $configPath -Name 'CTI_WORKFLOW_DRAIN_POLL_MS'
$fileForce = Get-ConfigEnvValue -ConfigPath $configPath -Name 'CTI_FORCE_RESTART_WITH_ACTIVE_WORKFLOWS'

# Windows 控制面板或 supervisor 可能继承旧 CTI_* 环境。与 Bridge 启动配置
# 保持同一口径：config.env 中显式存在的值优先，环境变量只作为兼容回退。
$configuredTimeout = if ($null -ne $fileTimeout) { $fileTimeout } else { $env:CTI_WORKFLOW_DRAIN_TIMEOUT_MS }
$configuredPoll = if ($null -ne $filePoll) { $filePoll } else { $env:CTI_WORKFLOW_DRAIN_POLL_MS }
$configuredForce = if ($null -ne $fileForce) { $fileForce } else { $env:CTI_FORCE_RESTART_WITH_ACTIVE_WORKFLOWS }

$effectiveTimeoutMs = if ($null -ne $TimeoutMs) {
    Convert-ToPositiveInt $TimeoutMs 30000 0 300000
} else {
    Convert-ToPositiveInt $configuredTimeout 30000 0 300000
}
$effectivePollMs = if ($null -ne $PollMs) {
    Convert-ToPositiveInt $PollMs 500 10 5000
} else {
    Convert-ToPositiveInt $configuredPoll 500 10 5000
}
$forceRestart = $Force.IsPresent -or ([string]$configuredForce -match '^(?:1|true|yes|on)$')

if ($forceRestart) {
    return [pscustomobject]@{
        Ok = $true
        Code = 0
        ActiveCount = 0
        CriticalCount = 0
        Stages = @()
        Forced = $true
        Message = 'Workflow drain was explicitly bypassed.'
    }
}

$deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($effectiveTimeoutMs)
$lastSnapshot = $null
do {
    if (-not (Test-Path -LiteralPath $StatusPath)) {
        return [pscustomobject]@{
            Ok = $true
            Code = 0
            ActiveCount = 0
            CriticalCount = 0
            Stages = @()
            Forced = $false
            Message = 'Workflow status file is absent; restart is allowed.'
        }
    }

    try {
        $state = Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $active = @($state.runs | Where-Object { $_.status -eq 'running' -or $_.status -eq 'retrying' })
        $critical = @($active | Where-Object {
            $_.status -eq 'retrying' -or $_.stage -eq 'executing' -or $_.stage -eq 'finalizing'
        })
        $stages = @($active | ForEach-Object { [string]$_.stage } | Where-Object { $_ } | Sort-Object -Unique)
        $lastSnapshot = [pscustomobject]@{
            ActiveCount = $active.Count
            CriticalCount = $critical.Count
            Stages = $stages
        }
        if ($active.Count -eq 0) {
            return [pscustomobject]@{
                Ok = $true
                Code = 0
                ActiveCount = 0
                CriticalCount = 0
                Stages = @()
                Forced = $false
                Message = 'Workflow queue is drained; restart is allowed.'
            }
        }
    }
    catch {
        # The status file is atomically replaced. Retry short read races instead
        # of treating an unreadable snapshot as an empty queue.
        $lastSnapshot = [pscustomobject]@{
            ActiveCount = -1
            CriticalCount = -1
            Stages = @('status_unreadable')
        }
    }

    if ([DateTimeOffset]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds $effectivePollMs
} while ($true)

return [pscustomobject]@{
    Ok = $false
    Code = 12
    ActiveCount = if ($lastSnapshot) { $lastSnapshot.ActiveCount } else { -1 }
    CriticalCount = if ($lastSnapshot) { $lastSnapshot.CriticalCount } else { -1 }
    Stages = if ($lastSnapshot) { @($lastSnapshot.Stages) } else { @('unknown') }
    Forced = $false
    Message = 'Workflow drain timed out; Bridge restart was postponed.'
}
