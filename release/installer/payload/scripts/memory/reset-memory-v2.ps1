param(
    [string]$MemoryRepo = $(if ($env:CTI_MEMORY_REPO_DIR) { $env:CTI_MEMORY_REPO_DIR } else { 'E:\cli-md' }),
    [string]$CtiHome = $(if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $HOME '.claude-to-im' }),
    [switch]$Apply,
    [switch]$AllowFutureReminders,
    [switch]$AllowRunningBridge
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

function Copy-ExistingPath {
    param(
        [string]$Source,
        [string]$BackupRoot,
        [string]$Label
    )
    if (-not (Test-Path -LiteralPath $Source)) { return $null }
    $target = Join-Path $BackupRoot $Label
    $targetDir = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    if (-not (Test-IsChildPath $target $BackupRoot)) {
        throw "Refusing to copy outside backup root: $target"
    }
    Copy-Item -LiteralPath $Source -Destination $target -Recurse -Force
    return $target
}

function Remove-RepoChildPath {
    param(
        [string]$Root,
        [string]$RelativePath
    )
    $target = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $target)) { return }
    if (-not (Test-IsChildPath $target $Root)) {
        throw "Refusing to remove outside memory repo: $target"
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}

function Get-FutureReminderSummary {
    param([string]$Root)
    $remindersPath = Join-Path $Root '.cti-index\reminders.json'
    if (-not (Test-Path -LiteralPath $remindersPath -PathType Leaf)) { return @() }
    try {
        $json = Get-Content -LiteralPath $remindersPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Unable to parse reminders before reset: $remindersPath"
    }
    $now = [DateTimeOffset]::UtcNow
    $items = @($json.reminders) | Where-Object {
        try {
            $due = [DateTimeOffset]::Parse([string]$_.dueAt)
        } catch {
            return $false
        }
        $due -gt $now -and ([string]$_.status -eq 'pending')
    } | Select-Object id,title,dueAt,status
    return @($items)
}

function Read-JsonUtf8 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Test-ProcessAlive {
    param([object]$PidValue)
    $pidText = [string]$PidValue
    if ([string]::IsNullOrWhiteSpace($pidText)) { return $false }
    try {
        $processId = [int]$pidText
        if ($processId -le 0) { return $false }
        return $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

function Test-FreshTimestamp {
    param(
        [object]$Value,
        [int]$MaxAgeSeconds = 180
    )
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $false }
    try {
        $timestamp = [DateTimeOffset]::Parse($text)
        return ([DateTimeOffset]::UtcNow - $timestamp.ToUniversalTime()).TotalSeconds -le $MaxAgeSeconds
    } catch {
        return $false
    }
}

function Get-BridgeRuntimeSummary {
    param([string]$CtiRoot)
    $status = Read-JsonUtf8 -Path (Join-Path $CtiRoot 'runtime\status.json')
    $audit = Read-JsonUtf8 -Path (Join-Path $CtiRoot 'runtime\bridge-runtime-audit.json')
    $statusPidAlive = Test-ProcessAlive -PidValue $status.pid
    $auditPidAlive = Test-ProcessAlive -PidValue $audit.pid
    $heartbeatFresh = Test-FreshTimestamp -Value $audit.lastHeartbeatAt -MaxAgeSeconds 180
    $running = ($status.running -eq $true -and $statusPidAlive) -or ($auditPidAlive -and $heartbeatFresh)
    return [ordered]@{
        running = [bool]$running
        pid = $(if ($status.pid) { $status.pid } else { $audit.pid })
        statusRunning = [bool]($status.running -eq $true)
        statusPidAlive = [bool]$statusPidAlive
        auditPidAlive = [bool]$auditPidAlive
        lastHeartbeatAt = [string]$audit.lastHeartbeatAt
    }
}

function Get-MemoryWatcherSummary {
    param([string]$Root)
    $status = Read-JsonUtf8 -Path (Join-Path $Root '.cti-index\status.json')
    $watcherPidAlive = Test-ProcessAlive -PidValue $status.watcherPid
    $statusFresh = Test-FreshTimestamp -Value $status.statusUpdatedAt -MaxAgeSeconds 180
    $running = $status.watching -eq $true -and ($watcherPidAlive -or $statusFresh)
    return [ordered]@{
        running = [bool]$running
        watching = [bool]($status.watching -eq $true)
        watcherPid = $status.watcherPid
        watcherPidAlive = [bool]$watcherPidAlive
        statusUpdatedAt = [string]$status.statusUpdatedAt
    }
}

function Write-JsonUtf8 {
    param(
        [string]$Path,
        [object]$Value
    )
    $dir = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $json = $Value | ConvertTo-Json -Depth 20
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

$root = Resolve-FullPath $MemoryRepo
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Memory repo not found: $root"
}

$ctiRoot = Resolve-FullPath $CtiHome
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $root "archive\memory-v2-reset\$stamp"
$futureReminders = Get-FutureReminderSummary -Root $root
$bridgeRuntime = Get-BridgeRuntimeSummary -CtiRoot $ctiRoot
$memoryWatcher = Get-MemoryWatcherSummary -Root $root

$plan = [ordered]@{
    schema = 'codex-im-suite/memory-v2-reset-plan/v1'
    memoryRepo = $root
    ctiHome = $ctiRoot
    generatedAt = (Get-Date).ToString('o')
    mode = $(if ($Apply) { 'apply' } else { 'dry-run' })
    backupRoot = $backupRoot
    futureReminderCount = $futureReminders.Count
    futureReminders = $futureReminders
    bridgeRuntime = $bridgeRuntime
    memoryWatcher = $memoryWatcher
    resetTargets = @(
        '.cti-index\knowledge.json',
        '.cti-index\memory-graph.json',
        '.cti-index\status.json',
        'data\explicit-memories',
        'data\memory',
        (Join-Path $ctiRoot 'data\memory-profiles.json')
    )
}

if (-not $Apply) {
    $plan | ConvertTo-Json -Depth 20
    exit 0
}

if ($futureReminders.Count -gt 0 -and -not $AllowFutureReminders) {
    throw "Refusing memory v2 reset because future pending reminders exist. Re-run with -AllowFutureReminders only after confirming reminder preservation."
}

if (($bridgeRuntime.running -or $memoryWatcher.running) -and -not $AllowRunningBridge) {
    throw "Refusing memory v2 reset while bridge or memory watcher is running. Stop the bridge first, or re-run with -AllowRunningBridge after accepting the race risk."
}

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

$backedUp = @()
$backupTargets = @(
    @{ Source = Join-Path $root '.cti-index\knowledge.json'; Label = '.cti-index\knowledge.json' },
    @{ Source = Join-Path $root '.cti-index\memory-graph.json'; Label = '.cti-index\memory-graph.json' },
    @{ Source = Join-Path $root '.cti-index\status.json'; Label = '.cti-index\status.json' },
    @{ Source = Join-Path $root '.cti-index\memory-optimizer-state.json'; Label = '.cti-index\memory-optimizer-state.json' },
    @{ Source = Join-Path $root 'data\explicit-memories'; Label = 'data\explicit-memories' },
    @{ Source = Join-Path $root 'data\memory'; Label = 'data\memory' },
    @{ Source = Join-Path $ctiRoot 'data\memory-profiles.json'; Label = 'cti-home\data\memory-profiles.json' }
)

foreach ($target in $backupTargets) {
    $backup = Copy-ExistingPath -Source $target.Source -BackupRoot $backupRoot -Label $target.Label
    if ($backup) { $backedUp += $backup }
}

Remove-RepoChildPath -Root $root -RelativePath '.cti-index\knowledge.json'
Remove-RepoChildPath -Root $root -RelativePath '.cti-index\memory-graph.json'
Remove-RepoChildPath -Root $root -RelativePath '.cti-index\status.json'
Remove-RepoChildPath -Root $root -RelativePath 'data\explicit-memories'
Remove-RepoChildPath -Root $root -RelativePath 'data\memory'

New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\memory\v2\users') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\memory\v2\groups') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\memory\v2\long-term') | Out-Null

$generatedAt = (Get-Date).ToUniversalTime().ToString('o')
Write-JsonUtf8 -Path (Join-Path $root '.cti-index\knowledge.json') -Value ([ordered]@{
    schema = 'codex-im-suite/knowledge-index/v1'
    memoryRoot = $root
    generatedAt = $generatedAt
    itemCount = 0
    conflictCount = 0
    items = @()
})
Write-JsonUtf8 -Path (Join-Path $root '.cti-index\memory-graph.json') -Value ([ordered]@{
    schema = 'codex-im-suite/memory-graph/v1'
    memoryRoot = $root
    generatedAt = $generatedAt
    nodeCount = 0
    edgeCount = 0
    nodes = @()
    edges = @()
})
Write-JsonUtf8 -Path (Join-Path $root '.cti-index\status.json') -Value ([ordered]@{
    schema = 'codex-im-suite/knowledge-index-status/v1'
    memoryRoot = $root
    indexPath = (Join-Path $root '.cti-index\knowledge.json')
    watching = $false
    exists = $true
    markdownFileCount = 0
    itemCount = 0
    conflictCount = 0
    memoryGraphPath = (Join-Path $root '.cti-index\memory-graph.json')
    memoryGraphNodeCount = 0
    memoryGraphEdgeCount = 0
    generatedAt = $generatedAt
    lastIndexedAt = $generatedAt
    statusUpdatedAt = $generatedAt
})

$profilesPath = Join-Path $ctiRoot 'data\memory-profiles.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profilesPath) | Out-Null
Set-Content -LiteralPath $profilesPath -Value '{}' -Encoding UTF8

[ordered]@{
    schema = 'codex-im-suite/memory-v2-reset-report/v1'
    memoryRepo = $root
    ctiHome = $ctiRoot
    appliedAt = (Get-Date).ToString('o')
    backupRoot = $backupRoot
    backedUp = $backedUp
    futureReminderCount = $futureReminders.Count
    bridgeRuntime = $bridgeRuntime
    memoryWatcher = $memoryWatcher
    knowledgeIndex = Join-Path $root '.cti-index\knowledge.json'
    memoryGraph = Join-Path $root '.cti-index\memory-graph.json'
    profilesPath = $profilesPath
} | ConvertTo-Json -Depth 20
