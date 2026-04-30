$ErrorActionPreference = 'Stop'

$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$runtimeDir = Join-Path $ctiHome 'runtime'
$configPath = Join-Path $ctiHome 'config.env'
$pidFile = Join-Path $runtimeDir 'ollama-server.pid'

function Get-ConfigMap {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $map
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

function Get-ConfigValue {
    param(
        [hashtable]$Map,
        [string]$Key,
        [string]$Fallback
    )
    if ($Map.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace($Map[$Key])) { return $Map[$Key] }
    return $Fallback
}

function Resolve-OllamaCommand {
    $command = Get-Command ollama -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\OllamaPortable\app\ollama.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
        (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ''
}

$config = Get-ConfigMap -Path $configPath
$baseUrl = Get-ConfigValue $config 'CTI_OLLAMA_BASE_URL' 'http://127.0.0.1:11434'
$model = Get-ConfigValue $config 'CTI_OLLAMA_MODEL' 'qwen2.5-coder:7b'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

try {
    $response = Invoke-RestMethod -Uri "$($baseUrl.TrimEnd('/'))/api/tags" -Method Get -TimeoutSec 3
    $models = @($response.models | ForEach-Object { if ($_.name) { $_.name } elseif ($_.model) { $_.model } })
    if ($models -contains $model) {
        Write-Output "already running: URL=$baseUrl MODEL=$model"
    } else {
        Write-Output "already running: URL=$baseUrl"
        Write-Output "model missing: $model"
        Write-Output "pull it with: ollama pull $model"
    }
    exit 0
} catch {
    # Continue and try to start a managed ollama serve process.
}

$ollama = Resolve-OllamaCommand
if (-not $ollama) {
    throw "Ollama CLI not found. Install Ollama first: https://ollama.com/download"
}

if (Test-Path -LiteralPath $pidFile) {
    $existingPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingPid) {
        $proc = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Output "managed ollama process already running: PID=$existingPid URL=$baseUrl"
            exit 0
        }
    }
}

$process = Start-Process -FilePath $ollama -ArgumentList 'serve' -WorkingDirectory $HOME -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
Write-Output "started: PID=$($process.Id) URL=$baseUrl"
Write-Output "model: $model"
Write-Output "if missing, run: ollama pull $model"
