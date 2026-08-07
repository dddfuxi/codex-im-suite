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
    'CTI_FORCE_RESTART_WITH_ACTIVE_WORKFLOWS=false' | Set-Content -LiteralPath $testConfigPath -Encoding UTF8
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
    $escapedSupervisorLog = $supervisorLog.Replace("'", "''")
    @"
param([string]`$Command, [int]`$LogLines = 50)
`$ErrorActionPreference = 'Stop'
`$OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
Add-Content -LiteralPath '$escapedSupervisorLog' -Encoding UTF8 -Value `$Command
exit 0
"@ | Set-Content -LiteralPath (Join-Path $daemonFixture 'supervisor-windows.ps1') -Encoding UTF8
    '{"protocol":"workflow-runtime/v1","runs":[]}' | Set-Content -LiteralPath (Join-Path $env:CTI_HOME 'runtime\workflow-runs.json') -Encoding UTF8
    $fixturePath = (Join-Path $daemonFixture 'daemon.ps1').Replace("'", "''")
    $fixtureCommand = @"
`$OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
& '$fixturePath' restart
exit `$LASTEXITCODE
"@
    $fixtureEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($fixtureCommand))
    $fixtureStdout = Join-Path $env:CTI_HOME 'daemon-fixture.stdout.log'
    $fixtureStderr = Join-Path $env:CTI_HOME 'daemon-fixture.stderr.log'
    $fixtureProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $fixtureEncoded) `
        -RedirectStandardOutput $fixtureStdout -RedirectStandardError $fixtureStderr `
        -Wait -PassThru -WindowStyle Hidden
    if ($fixtureProcess.ExitCode -ne 0) {
        $fixtureOutput = if (Test-Path -LiteralPath $fixtureStdout) { Get-Content -LiteralPath $fixtureStdout -Encoding UTF8 -Raw } else { '<missing stdout>' }
        $fixtureError = if (Test-Path -LiteralPath $fixtureStderr) { Get-Content -LiteralPath $fixtureStderr -Encoding UTF8 -Raw } else { '<missing stderr>' }
        $fixtureSupervisor = if (Test-Path -LiteralPath $supervisorLog) { Get-Content -LiteralPath $supervisorLog -Encoding UTF8 -Raw } else { '<missing supervisor log>' }
        throw "daemon restart fixture failed with exit code $($fixtureProcess.ExitCode); stdout=$fixtureOutput; stderr=$fixtureError; supervisor=$fixtureSupervisor"
    }
    if (-not (Test-Path -LiteralPath $supervisorLog)) {
        $fixtureOutput = if (Test-Path -LiteralPath $fixtureStdout) { Get-Content -LiteralPath $fixtureStdout -Encoding UTF8 -Raw } else { '<missing stdout>' }
        $fixtureError = if (Test-Path -LiteralPath $fixtureStderr) { Get-Content -LiteralPath $fixtureStderr -Encoding UTF8 -Raw } else { '<missing stderr>' }
        throw "daemon restart fixture did not invoke supervisor; stdout=$fixtureOutput; stderr=$fixtureError"
    }
    $supervisorCommands = @(Get-Content -LiteralPath $supervisorLog -Encoding UTF8)
    if (($supervisorCommands -join ',') -ne 'stop,start') {
        throw "daemon restart must execute isolated stop,start commands; actual=$($supervisorCommands -join ',')"
    }

    $daemon = Get-Content -LiteralPath $daemonScript -Raw -Encoding UTF8
    $supervisor = Get-Content -LiteralPath $supervisorScriptPath -Raw -Encoding UTF8
    $program = Get-Content -LiteralPath $programPath -Raw -Encoding UTF8
    $runtimeUpdates = Get-Content -LiteralPath $runtimeUpdatesPath -Raw -Encoding UTF8
    $syncScript = Get-Content -LiteralPath $syncScriptPath -Raw -Encoding UTF8
    $sharedScript = Get-Content -LiteralPath $sharedScriptPath -Raw -Encoding UTF8
    $portableScript = Get-Content -LiteralPath $portableScriptPath -Raw -Encoding UTF8
    $installerScript = Get-Content -LiteralPath $installerScriptPath -Raw -Encoding UTF8
    if ($daemon -notmatch 'workflow-drain\.ps1') { throw 'daemon restart must invoke workflow drain' }
    if ($daemon -match 'RedirectStandardOutput\s*=\s*\$true' -or $daemon -match 'RedirectStandardError\s*=\s*\$true') {
        throw 'isolated supervisor commands must not use anonymous output pipes'
    }
    if ($daemon -notmatch 'RedirectStandardOutput\s*=\s*\$childStdoutPath' -or $daemon -notmatch 'RedirectStandardError\s*=\s*\$childStderrPath') {
        throw 'isolated supervisor commands must use dedicated output files'
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
