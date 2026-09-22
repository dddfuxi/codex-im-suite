<#
.SYNOPSIS
  Windows entry point — delegates to supervisor-windows.ps1.
.DESCRIPTION
  Usage:  powershell -File scripts\daemon.ps1 start|stop|status|logs|install-service|uninstall-service
#>
param(
    [Parameter(Position=0)]
    [string]$Command = 'help',

    [Parameter(Position=1)]
    [int]$LogLines = 50,

    [switch]$Force,

    [Nullable[int]]$DrainTimeoutMs = $null,

    [ValidateSet('cli','control_panel','bridge_control','service','automation','unknown')]
    [string]$Source = 'cli'
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$supervisorScript = Join-Path (Split-Path -Parent $PSCommandPath) 'supervisor-windows.ps1'

function Write-WorkflowLifecycleAudit {
    param(
        [string]$Operation,
        [string]$LifecycleSource,
        [object]$DrainResult
    )

    # Record only redacted lifecycle facts. Never include workflow content,
    # identities, absolute paths, or process-specific values in this audit.
    try {
        $ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
        $runtimeDir = Join-Path $ctiHome 'runtime'
        New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
        $auditPath = Join-Path $runtimeDir 'workflow-lifecycle-audit.jsonl'
        $decision = if ($DrainResult.Ok) {
            if ($DrainResult.Forced) { 'forced' } else { 'allowed' }
        } else {
            'postponed'
        }
        $record = [ordered]@{
            protocol = 'workflow-lifecycle-audit/v1'
            at = [DateTimeOffset]::UtcNow.ToString('o')
            operation = $Operation
            source = $LifecycleSource
            decision = $decision
            activeCount = [int]$DrainResult.ActiveCount
            criticalCount = [int]$DrainResult.CriticalCount
            stages = @($DrainResult.Stages)
        }
        Add-Content -LiteralPath $auditPath -Encoding UTF8 -Value ($record | ConvertTo-Json -Compress -Depth 4)
    } catch {
        Write-Warning 'Workflow lifecycle audit could not be written.'
    }
}

function Invoke-WorkflowDrainGate {
    param(
        [string]$Operation,
        [string]$LifecycleSource,
        [switch]$ForceDrain,
        [Nullable[int]]$RequestedTimeoutMs = $null
    )

    $drainScript = Join-Path (Split-Path -Parent $PSCommandPath) 'workflow-drain.ps1'
    if (-not (Test-Path -LiteralPath $drainScript)) {
        [Console]::Error.WriteLine("Workflow drain script missing: $drainScript")
        exit 13
    }
    $drainArguments = @{ Force = $ForceDrain.IsPresent }
    if ($null -ne $RequestedTimeoutMs) { $drainArguments.TimeoutMs = $RequestedTimeoutMs }
    $drain = & $drainScript @drainArguments
    Write-WorkflowLifecycleAudit -Operation $Operation -LifecycleSource $LifecycleSource -DrainResult $drain
    if (-not $drain.Ok) {
        [Console]::Error.WriteLine(("{0} operation={1} source={2} active={3} critical={4} stages={5}" -f $drain.Message, $Operation, $LifecycleSource, $drain.ActiveCount, $drain.CriticalCount, (@($drain.Stages) -join ',')))
        exit $drain.Code
    }
    Write-Output $drain.Message
    return $drain
}

function Invoke-IsolatedSupervisorCommand {
    param(
        [string]$SupervisorCommand,
        [string]$ScriptPath,
        [int]$RequestedLogLines
    )

    # supervisor-windows.ps1 is a standalone entry point and exits the host.
    # Run stop/start in separate child processes so stop cannot terminate restart.
    if ([string]::IsNullOrWhiteSpace($ScriptPath)) {
        throw 'Supervisor script path is missing.'
    }
    # Never capture background-capable commands through anonymous pipes. A
    # descendant can inherit a pipe handle and keep ReadToEnd blocked after the
    # direct command has exited. Dedicated files make the wait process-scoped.
    $commandOutputDir = Join-Path ([IO.Path]::GetTempPath()) 'codex-im-suite\daemon-command'
    New-Item -ItemType Directory -Force -Path $commandOutputDir | Out-Null
    $commandId = [Guid]::NewGuid().ToString('N')
    $childStdoutPath = Join-Path $commandOutputDir "$commandId.stdout.log"
    $childStderrPath = Join-Path $commandOutputDir "$commandId.stderr.log"
    $childExitCodePath = Join-Path $commandOutputDir "$commandId.exit-code.txt"
    $startCompletionMarker = 'CTI_DAEMON_START_READY_V1'
    $escapedScript = $ScriptPath.Replace("'", "''")
    $escapedExitCodePath = $childExitCodePath.Replace("'", "''")
    $childCommand = "`$ErrorActionPreference='Stop'; `$OutputEncoding=[System.Text.UTF8Encoding]::new(`$false); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new(`$false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(`$false); `$commandExitCode=0; try { & '$escapedScript' -Command '$SupervisorCommand' -LogLines $RequestedLogLines -CommandCompletionPath '$escapedExitCodePath'; if (`$null -ne `$LASTEXITCODE) { `$commandExitCode=[int]`$LASTEXITCODE } } catch { [Console]::Error.WriteLine(`$_.Exception.Message); `$commandExitCode=1 } finally { [IO.File]::WriteAllText('$escapedExitCodePath', [string]`$commandExitCode, [Text.UTF8Encoding]::new(`$false)) }; exit `$commandExitCode"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
    $process = $null
    try {
        $childArgumentList = @(
            '-NoLogo'
            '-NoProfile'
            '-ExecutionPolicy'
            'Bypass'
            '-EncodedCommand'
            $encodedCommand
        )
        $childStartArgs = @{
            FilePath = 'powershell.exe'
            ArgumentList = $childArgumentList
            WindowStyle = 'Hidden'
            RedirectStandardOutput = $childStdoutPath
            RedirectStandardError = $childStderrPath
            PassThru = $true
        }
        $process = Start-Process @childStartArgs
        $startCompletionObserved = $false
        if ($SupervisorCommand -eq 'start') {
            # start 会创建长驻 Supervisor。成功门禁由 supervisor 在完成 PID、
            # status 与进程检查后先写入独立回执；命令包装器是否还被后台句柄
            # 拖住，不再影响 restart 的完成时间。
            while ((-not $process.HasExited) -and (-not $startCompletionObserved)) {
                if (Test-Path -LiteralPath $childExitCodePath) {
                    $startCompletionObserved = $true
                    break
                }
                if (Test-Path -LiteralPath $childStdoutPath) {
                    try {
                        $startCompletionObserved = (Get-Content -LiteralPath $childStdoutPath -Raw -Encoding UTF8).Contains($startCompletionMarker)
                    } catch {
                        # Redirected output may be between writes; the next poll retries.
                    }
                }
                Start-Sleep -Milliseconds 50
            }
            if ($startCompletionObserved -and (-not $process.HasExited)) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        }
        $process.WaitForExit()
        $childStdout = if (Test-Path -LiteralPath $childStdoutPath) { Get-Content -LiteralPath $childStdoutPath -Raw -Encoding UTF8 } else { '' }
        $childStderr = if (Test-Path -LiteralPath $childStderrPath) { Get-Content -LiteralPath $childStderrPath -Raw -Encoding UTF8 } else { '' }
        $reportedExitCode = if ($startCompletionObserved) { 0 } else { 1 }
        $reportedExitCodeText = if (Test-Path -LiteralPath $childExitCodePath) { (Get-Content -LiteralPath $childExitCodePath -Raw -Encoding UTF8).Trim() } else { '' }
        [void][int]::TryParse($reportedExitCodeText, [ref]$reportedExitCode)
        if ($reportedExitCode -ne 0) {
            $detail = @($childStderr, $childStdout) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
            throw "Supervisor command '$SupervisorCommand' failed with exit code $reportedExitCode`: $($detail -join ' | ')"
        }
        return $reportedExitCode
    }
    finally {
        foreach ($path in @($childStdoutPath, $childStderrPath, $childExitCodePath)) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
        }
        if ($process) { $process.Dispose() }
    }
}

if ($Command -in @('stop', 'restart', 'uninstall-service')) {
    # Every supported termination path shares the same gate. -Force remains
    # an explicit recovery escape hatch; normal timeouts postpone termination.
    [void](Invoke-WorkflowDrainGate -Operation $Command -LifecycleSource $Source -ForceDrain:$Force.IsPresent -RequestedTimeoutMs $DrainTimeoutMs)
}

if ($Command -eq 'restart') {
    $stopCode = Invoke-IsolatedSupervisorCommand -SupervisorCommand 'stop' -ScriptPath $supervisorScript -RequestedLogLines $LogLines
    if ($stopCode -ne 0) { exit $stopCode }
    $startCode = Invoke-IsolatedSupervisorCommand -SupervisorCommand 'start' -ScriptPath $supervisorScript -RequestedLogLines $LogLines
    exit $startCode
}

& $supervisorScript -Command $Command -LogLines $LogLines
