$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$suiteRoot = Split-Path -Parent $PSScriptRoot
$drainScript = Join-Path $suiteRoot 'packages\bridge-runtime\scripts\workflow-drain.ps1'
$daemonScript = Join-Path $suiteRoot 'packages\bridge-runtime\scripts\daemon.ps1'
$supervisorScriptPath = Join-Path $suiteRoot 'packages\bridge-runtime\scripts\supervisor-windows.ps1'
$programPath = Join-Path $suiteRoot 'apps\control-panel\Program.cs'
$runtimeUpdatesPath = Join-Path $suiteRoot 'apps\control-panel\MainForm.RuntimeUpdates.cs'
$syncScriptPath = Join-Path $suiteRoot 'scripts\sync-live-skill.ps1'
$sharedScriptPath = Join-Path $suiteRoot 'scripts\shared.ps1'
$portableScriptPath = Join-Path $suiteRoot 'scripts\assemble-portable.ps1'
$installerScriptPath = Join-Path $suiteRoot 'scripts\build-installer.ps1'
$workflowDrainTestRoot = Join-Path ([IO.Path]::GetTempPath()) ("cti-workflow-drain-test-" + [Guid]::NewGuid())
$statusPath = Join-Path $workflowDrainTestRoot 'workflow-runs.json'
$savedCtiHome = $env:CTI_HOME
$savedForce = $env:CTI_FORCE_RESTART_WITH_ACTIVE_WORKFLOWS
$fixtureBackgroundPid = 0
$fixtureProcess = $null

try {
    New-Item -ItemType Directory -Path $workflowDrainTestRoot -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $workflowDrainTestRoot 'runtime') -Force | Out-Null
    $env:CTI_HOME = $workflowDrainTestRoot
    '{"protocol":"workflow-runtime/v1","runs":[]}' | Set-Content -LiteralPath $statusPath -Encoding UTF8
    $empty = & $drainScript -StatusPath $statusPath -TimeoutMs 20 -PollMs 10
    if (-not $empty.Ok -or $empty.ActiveCount -ne 0) { throw 'empty workflow state should drain immediately' }

    '{"protocol":"workflow-runtime/v1","runs":[{"status":"running","stage":"executing"}]}' |
        Set-Content -LiteralPath $statusPath -Encoding UTF8
    $active = & $drainScript -StatusPath $statusPath -TimeoutMs 30 -PollMs 10
    if ($active.Ok -or $active.Code -ne 12 -or $active.CriticalCount -ne 1) {
        throw 'executing workflow should postpone restart after timeout'
    }

    $forced = & $drainScript -StatusPath $statusPath -TimeoutMs 0 -PollMs 10 -Force
    if (-not $forced.Ok -or -not $forced.Forced) { throw 'explicit force should provide the recovery escape hatch' }

    # config.env 是现场配置唯一事实源，不能被控制面板继承的旧 force=true 覆盖。
    if ([string]::IsNullOrWhiteSpace($workflowDrainTestRoot)) { throw 'workflow drain test root was unexpectedly cleared' }
    $testConfigPath = Join-Path $workflowDrainTestRoot 'config.env'
    @(
        'CTI_FORCE_RESTART_WITH_ACTIVE_WORKFLOWS=false'
        'CTI_WORKFLOW_DRAIN_TIMEOUT_MS=0'
    ) | Set-Content -LiteralPath $testConfigPath -Encoding UTF8
    if (-not (Test-Path -LiteralPath $testConfigPath)) { throw "failed to create workflow drain test config: $testConfigPath" }
    $env:CTI_FORCE_RESTART_WITH_ACTIVE_WORKFLOWS = 'true'
    $configWins = & $drainScript -StatusPath $statusPath -TimeoutMs 0 -PollMs 10
    if ($configWins.Ok -or $configWins.Code -ne 12) {
        $configDebugPath = Join-Path $env:CTI_HOME 'config.env'
        $configDebug = if (Test-Path -LiteralPath $configDebugPath) { Get-Content -LiteralPath $configDebugPath -Raw -Encoding UTF8 } else { '<missing>' }
        $debugMessage = "config.env must override stale inherited force environment: result=$($configWins | ConvertTo-Json -Compress -Depth 5); ctiHome=$($env:CTI_HOME); config=$configDebug"
        throw $debugMessage
    }

    # 集成验证：supervisor 内部即使 exit，daemon restart 也必须继续执行 start。
    if (-not $env:CTI_HOME) { throw 'workflow drain integration root is missing' }
    $daemonFixture = Join-Path $env:CTI_HOME 'daemon fixture with spaces'
    New-Item -ItemType Directory -Path $daemonFixture -Force | Out-Null
    Copy-Item -LiteralPath $daemonScript -Destination (Join-Path $daemonFixture 'daemon.ps1') -Force
    Copy-Item -LiteralPath $drainScript -Destination (Join-Path $daemonFixture 'workflow-drain.ps1') -Force
    $supervisorLog = Join-Path $env:CTI_HOME 'supervisor-commands.txt'
    $fixtureBackgroundPidPath = Join-Path $env:CTI_HOME 'fixture-background.pid'
    $escapedSupervisorLog = $supervisorLog.Replace("'", "''")
    $escapedBackgroundPidPath = $fixtureBackgroundPidPath.Replace("'", "''")
    @"
param([string]`$Command, [int]`$LogLines = 50, [string]`$CommandCompletionPath = '')
`$ErrorActionPreference = 'Stop'
`$OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
Add-Content -LiteralPath '$escapedSupervisorLog' -Encoding UTF8 -Value `$Command
if (`$Command -eq 'start') {
    `$backgroundCommand = 'Start-Sleep -Seconds 30'
    `$backgroundEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(`$backgroundCommand))
    `$background = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', `$backgroundEncoded) -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath '$escapedBackgroundPidPath' -Encoding UTF8 -Value `$background.Id
    Write-Output 'CTI_DAEMON_START_READY_V1'
    Write-Host "Bridge started (fixture background PID: `$(`$background.Id))"
    # 模拟真实现场：后台句柄让命令包装器迟迟不退。daemon 必须根据独立
    # 成功回执结束包装器，同时保留这个长驻受管进程。
    Start-Sleep -Seconds 30
}
exit 0
"@ | Set-Content -LiteralPath (Join-Path $daemonFixture 'supervisor-windows.ps1') -Encoding UTF8
    # Real entry-point check: stop must fail closed before the Supervisor is
    # called when an executing Workflow is present.
    Set-Content -LiteralPath (Join-Path $env:CTI_HOME 'runtime\workflow-runs.json') -Encoding UTF8 -Value '{"protocol":"workflow-runtime/v1","runs":[{"status":"running","stage":"executing"}]}'
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $blockedStopOutput = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $daemonFixture 'daemon.ps1') stop -Source automation -DrainTimeoutMs 0 2>&1
    $blockedStopExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorActionPreference
    if ($blockedStopExitCode -ne 12) { throw "active workflow stop should be postponed with exit 12; actual=$blockedStopExitCode; output=$($blockedStopOutput -join ' | ')" }
    if (Test-Path -LiteralPath $supervisorLog) { throw 'blocked stop must not reach the Supervisor' }
    $lifecycleAuditPath = Join-Path $env:CTI_HOME 'runtime\workflow-lifecycle-audit.jsonl'
    if (-not (Test-Path -LiteralPath $lifecycleAuditPath)) { throw 'drain decision must write lifecycle audit' }
    $lifecycleAudit = Get-Content -LiteralPath $lifecycleAuditPath -Encoding UTF8 | Select-Object -Last 1 | ConvertFrom-Json
    if ($lifecycleAudit.operation -ne 'stop' -or $lifecycleAudit.source -ne 'automation' -or $lifecycleAudit.decision -ne 'postponed' -or $lifecycleAudit.activeCount -ne 1) {
        throw "unexpected lifecycle audit: $($lifecycleAudit | ConvertTo-Json -Compress -Depth 5)"
    }
    Set-Content -LiteralPath (Join-Path $env:CTI_HOME 'runtime\workflow-runs.json') -Encoding UTF8 -Value '{"protocol":"workflow-runtime/v1","runs":[]}'
    $fixturePath = (Join-Path $daemonFixture 'daemon.ps1').Replace("'", "''")
    $fixtureCommand = @"
`$OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
& '$fixturePath' restart
exit `$LASTEXITCODE
"@
    $fixtureEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($fixtureCommand))
    $fixtureStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $fixtureStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $fixtureStartInfo.FileName = 'powershell.exe'
    $fixtureStartInfo.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $fixtureEncoded"
    $fixtureStartInfo.UseShellExecute = $false
    $fixtureStartInfo.CreateNoWindow = $true
    $fixtureStartInfo.RedirectStandardOutput = $true
    $fixtureStartInfo.RedirectStandardError = $true
    $fixtureProcess = [Diagnostics.Process]::new()
    $fixtureProcess.StartInfo = $fixtureStartInfo
    if (-not $fixtureProcess.Start()) { throw 'failed to start daemon restart fixture' }
    $fixtureStdoutTask = $fixtureProcess.StandardOutput.ReadToEndAsync()
    $fixtureStderrTask = $fixtureProcess.StandardError.ReadToEndAsync()
    # 只等待直接命令进程；若这里使用 Start-Process -Wait，Windows 会等待
    # 整棵进程树，反而无法验证 daemon 包装器是否已经独立退出。
    $fixtureProcess.WaitForExit()
    $fixtureOutput = $fixtureStdoutTask.GetAwaiter().GetResult()
    $fixtureError = $fixtureStderrTask.GetAwaiter().GetResult()
    $fixtureStopwatch.Stop()
    if ($fixtureProcess.ExitCode -ne 0) {
        $fixtureSupervisor = if (Test-Path -LiteralPath $supervisorLog) { Get-Content -LiteralPath $supervisorLog -Encoding UTF8 -Raw } else { '<missing supervisor log>' }
        throw "daemon restart fixture failed with exit code $($fixtureProcess.ExitCode); stdout=$fixtureOutput; stderr=$fixtureError; supervisor=$fixtureSupervisor"
    }
    if (-not (Test-Path -LiteralPath $supervisorLog)) {
        throw "daemon restart fixture did not invoke supervisor; stdout=$fixtureOutput; stderr=$fixtureError"
    }
    $supervisorCommands = @(Get-Content -LiteralPath $supervisorLog -Encoding UTF8)
    if (($supervisorCommands -join ',') -ne 'stop,start') {
        throw "daemon restart must execute isolated stop,start commands; actual=$($supervisorCommands -join ',')"
    }
    if ($fixtureStopwatch.Elapsed.TotalSeconds -ge 10) {
        throw "daemon restart must not wait for a long-lived start wrapper; elapsed=$([Math]::Round($fixtureStopwatch.Elapsed.TotalSeconds, 2))s"
    }
    $fixtureBackgroundPid = if (Test-Path -LiteralPath $fixtureBackgroundPidPath) {
        [int](Get-Content -LiteralPath $fixtureBackgroundPidPath -Raw -Encoding UTF8).Trim()
    } else { 0 }
    if ($fixtureBackgroundPid -le 0 -or -not (Get-Process -Id $fixtureBackgroundPid -ErrorAction SilentlyContinue)) {
        throw 'daemon restart must preserve the managed background process after retiring its command wrapper'
    }
    $fixtureBackground = Get-Process -Id $fixtureBackgroundPid -ErrorAction SilentlyContinue
    if ($fixtureBackground) {
        Stop-Process -Id $fixtureBackgroundPid -Force -ErrorAction SilentlyContinue
        [void]$fixtureBackground.WaitForExit(5000)
        $fixtureBackground.Dispose()
    }
    $fixtureBackgroundPid = 0
    $fixtureProcess.Dispose()
    $fixtureProcess = $null

    $daemon = Get-Content -LiteralPath $daemonScript -Raw -Encoding UTF8
    $supervisor = Get-Content -LiteralPath $supervisorScriptPath -Raw -Encoding UTF8
    $program = Get-Content -LiteralPath $programPath -Raw -Encoding UTF8
    $runtimeUpdates = Get-Content -LiteralPath $runtimeUpdatesPath -Raw -Encoding UTF8
    $syncScript = Get-Content -LiteralPath $syncScriptPath -Raw -Encoding UTF8
    $sharedScript = Get-Content -LiteralPath $sharedScriptPath -Raw -Encoding UTF8
    $portableScript = Get-Content -LiteralPath $portableScriptPath -Raw -Encoding UTF8
    $installerScript = Get-Content -LiteralPath $installerScriptPath -Raw -Encoding UTF8
    if ($daemon -notmatch 'workflow-drain\.ps1') { throw 'daemon lifecycle commands must invoke workflow drain' }
    if ($daemon -notmatch "'stop', 'restart', 'uninstall-service'") { throw 'stop, restart and service removal must share the drain gate' }
    if ($daemon -notmatch 'Write-WorkflowLifecycleAudit') { throw 'lifecycle drain decisions must be auditable' }
    if ($daemon -match 'RedirectStandardOutput\s*=\s*\$true' -or $daemon -match 'RedirectStandardError\s*=\s*\$true') {
        throw 'isolated supervisor commands must not use anonymous output pipes'
    }
    if ($daemon -notmatch 'RedirectStandardOutput\s*=\s*\$childStdoutPath' -or $daemon -notmatch 'RedirectStandardError\s*=\s*\$childStderrPath') {
        throw 'isolated supervisor commands must use dedicated output files'
    }
    if ($daemon -notmatch 'CTI_DAEMON_START_READY_V1' -or $supervisor -notmatch 'CTI_DAEMON_START_READY_V1') {
        throw 'start wrapper retirement must share the explicit readiness marker protocol'
    }
    # Accept direct parameters and splatted Start-Process arguments. Both forms
    # isolate the background supervisor from the caller's anonymous pipes.
    if ($supervisor -notmatch 'RedirectStandardOutput\s*(?:=|\s)\s*\$SupervisorLogFile' -or $supervisor -notmatch 'RedirectStandardError\s*(?:=|\s)\s*\$SupervisorErrorLogFile') {
        throw 'background supervisor must not inherit restart command output pipes'
    }
    if ($supervisor -notmatch "'-EncodedCommand'" -or $supervisor -notmatch 'encodedSupervisorCommand') {
        throw 'background supervisor must encode its command instead of passing an unquoted -File path'
    }
    if ($supervisor -notmatch 'ConvertTo-WindowsCommandLineArgument\s+\$DaemonMjs') {
        throw 'Node daemon bundle path must be explicitly quoted for Start-Process on Windows'
    }
    if ($program -notmatch 'RunDaemonAsync\("restart"\)') { throw 'control panel restart must use daemon restart' }
    if ($program -notmatch 'Source control_panel') { throw 'control panel lifecycle commands must identify their source' }
    if ($program -notmatch 'isolateBackgroundOutput:\s*preserveManagedChildren' -or $program -notmatch 'RunPowerShellFileWithIsolatedOutputAsync') {
        throw 'control panel start/restart must isolate long-lived descendants from anonymous output pipes'
    }
    if ($runtimeUpdates -notmatch 'workflow-drain\.ps1') { throw 'copy-install drift probe must include workflow drain' }
    if (-not $syncScript.Contains("Join-Path `$suiteRuntime 'scripts'")) { throw 'live sync must mirror runtime scripts' }
    if (-not $sharedScript.Contains("`$map['runtime.scripts']")) { throw 'release fingerprint must cover runtime scripts' }
    if ($portableScript -notmatch "@\('dist', 'scripts'") { throw 'portable assembly must include runtime scripts' }
    if (-not $installerScript.Contains("Join-Path `$portableDir '*'")) { throw 'installer payload must inherit portable runtime scripts' }

    Write-Host 'Workflow drain checks passed.'
}
finally {
    $cleanupRoot = $env:CTI_HOME
    $env:CTI_HOME = $savedCtiHome
    $env:CTI_FORCE_RESTART_WITH_ACTIVE_WORKFLOWS = $savedForce
    if ($fixtureBackgroundPid -gt 0) {
        $fixtureBackground = Get-Process -Id $fixtureBackgroundPid -ErrorAction SilentlyContinue
        if ($fixtureBackground) {
            Stop-Process -Id $fixtureBackgroundPid -Force -ErrorAction SilentlyContinue
            [void]$fixtureBackground.WaitForExit(5000)
            $fixtureBackground.Dispose()
        }
    }
    if ($fixtureProcess) { $fixtureProcess.Dispose() }
    if ($cleanupRoot -and (Test-Path -LiteralPath $cleanupRoot)) {
        $resolvedCleanupRoot = [IO.Path]::GetFullPath($cleanupRoot).TrimEnd('\', '/')
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        $expectedPrefix = Join-Path $tempBase 'cti-workflow-drain-test-'
        if ($resolvedCleanupRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedCleanupRoot -Recurse -Force
        } else {
            Write-Warning "Skip unexpected workflow drain test cleanup target: $resolvedCleanupRoot"
        }
    }
}
