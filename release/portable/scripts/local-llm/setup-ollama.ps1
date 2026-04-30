$ErrorActionPreference = 'Stop'

$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$configPath = Join-Path $ctiHome 'config.env'

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
$ollama = Resolve-OllamaCommand

if ($ollama) {
    Write-Output "Ollama CLI: $ollama"
} else {
    Write-Output 'Ollama CLI: not found'
    Write-Output 'Install Ollama: https://ollama.com/download'
    exit 1
}

Write-Output "Base URL: $baseUrl"
Write-Output "Model: $model"

try {
    $response = Invoke-RestMethod -Uri "$($baseUrl.TrimEnd('/'))/api/tags" -Method Get -TimeoutSec 5
    $models = @($response.models | ForEach-Object { if ($_.name) { $_.name } elseif ($_.model) { $_.model } })
    if ($models -contains $model) {
        Write-Output "Ready: model available"
        exit 0
    }
    Write-Output "Service online, model missing: $model"
    Write-Output "Run: ollama pull $model"
    exit 2
} catch {
    Write-Output "Service offline: $($_.Exception.Message)"
    Write-Output "Run: ollama serve"
    Write-Output "Then run: ollama pull $model"
    exit 2
}
