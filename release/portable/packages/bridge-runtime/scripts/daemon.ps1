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
    [int]$LogLines = 50
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$supervisorScript = Join-Path (Split-Path -Parent $PSCommandPath) 'supervisor-windows.ps1'

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
    $escapedScript = $ScriptPath.Replace("'", "''")
    $escapedExitCodePath = $childExitCodePath.Replace("'", "''")
    $childCommand = "`$ErrorActionPreference='Stop'; `$OutputEncoding=[System.Text.UTF8Encoding]::new(`$false); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new(`$false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(`$false); `$commandExitCode=0; try { & '$escapedScript' -Command '$SupervisorCommand' -LogLines $RequestedLogLines; if (`$null -ne `$LASTEXITCODE) { `$commandExitCode=[int]`$LASTEXITCODE } } catch { [Console]::Error.WriteLine(`$_.Exception.Message); `$commandExitCode=1 } finally { [IO.File]::WriteAllText('$escapedExitCodePath', [string]`$commandExitCode, [Text.UTF8Encoding]::new(`$false)) }; exit `$commandExitCode"
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
        $process.WaitForExit()
        $childStdout = if (Test-Path -LiteralPath $childStdoutPath) { Get-Content -LiteralPath $childStdoutPath -Raw -Encoding UTF8 } else { '' }
        $childStderr = if (Test-Path -LiteralPath $childStderrPath) { Get-Content -LiteralPath $childStderrPath -Raw -Encoding UTF8 } else { '' }
        $reportedExitCode = 1
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

if ($Command -eq 'restart') {
    $drainScript = Join-Path (Split-Path -Parent $PSCommandPath) 'workflow-drain.ps1'
    if (-not (Test-Path -LiteralPath $drainScript)) {
        Write-Error "Workflow drain script missing: $drainScript"
        exit 13
    }
    $drain = & $drainScript
    if (-not $drain.Ok) {
        Write-Error ("{0} active={1} critical={2} stages={3}" -f $drain.Message, $drain.ActiveCount, $drain.CriticalCount, (@($drain.Stages) -join ','))
        exit $drain.Code
    }
    Write-Output $drain.Message
    $stopCode = Invoke-IsolatedSupervisorCommand -SupervisorCommand 'stop' -ScriptPath $supervisorScript -RequestedLogLines $LogLines
    if ($stopCode -ne 0) { exit $stopCode }
    $startCode = Invoke-IsolatedSupervisorCommand -SupervisorCommand 'start' -ScriptPath $supervisorScript -RequestedLogLines $LogLines
    exit $startCode
}

& $supervisorScript -Command $Command -LogLines $LogLines
