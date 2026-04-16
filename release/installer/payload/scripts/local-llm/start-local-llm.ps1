$ErrorActionPreference = 'Stop'

$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$runtimeDir = Join-Path $ctiHome 'runtime'
$configPath = Join-Path $ctiHome 'config.env'
$pidFile = Join-Path $runtimeDir 'local-llm-server.pid'

function Get-ConfigMap {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing config: $Path"
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

$config = Get-ConfigMap -Path $configPath
$serverExe = if ($config.ContainsKey('CTI_LOCAL_LLM_SERVER_EXE')) { $config['CTI_LOCAL_LLM_SERVER_EXE'] } else { '' }
$modelPath = if ($config.ContainsKey('CTI_LOCAL_LLM_MODEL_PATH')) { $config['CTI_LOCAL_LLM_MODEL_PATH'] } else { '' }
$baseUrl = if ($config.ContainsKey('CTI_LOCAL_LLM_BASE_URL')) { $config['CTI_LOCAL_LLM_BASE_URL'] } else { 'http://127.0.0.1:8080' }
$extraArgs = if ($config.ContainsKey('CTI_LOCAL_LLM_SERVER_ARGS')) { $config['CTI_LOCAL_LLM_SERVER_ARGS'] } else { '' }

if (-not $serverExe) {
    $cmd = Get-Command llama-server -ErrorAction SilentlyContinue
    if ($cmd) { $serverExe = $cmd.Source }
}

if (-not $serverExe -or -not (Test-Path -LiteralPath $serverExe)) {
    throw 'llama-server executable not found. Set CTI_LOCAL_LLM_SERVER_EXE.'
}
if (-not $modelPath -or -not (Test-Path -LiteralPath $modelPath)) {
    throw 'GGUF model file not found. Set CTI_LOCAL_LLM_MODEL_PATH.'
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

if (Test-Path -LiteralPath $pidFile) {
    $existingPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingPid) {
        $proc = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Output "already running: PID=$existingPid"
            exit 0
        }
    }
}

$uri = [System.Uri]$baseUrl
$hostName = $uri.Host
$port = $uri.Port
$arguments = @("-m `"$modelPath`"", "--host $hostName", "--port $port")
if ($extraArgs) {
    $arguments += $extraArgs
}

$workingDir = Split-Path -Parent $serverExe
$process = Start-Process -FilePath $serverExe -ArgumentList ($arguments -join ' ') -WorkingDirectory $workingDir -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
Write-Output "started: PID=$($process.Id) URL=$baseUrl"
