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

$config = Get-ConfigMap -Path $configPath
$serverExe = if ($config.ContainsKey('CTI_LOCAL_LLM_SERVER_EXE')) { $config['CTI_LOCAL_LLM_SERVER_EXE'] } else { '' }
$modelPath = if ($config.ContainsKey('CTI_LOCAL_LLM_MODEL_PATH')) { $config['CTI_LOCAL_LLM_MODEL_PATH'] } else { '' }
$baseUrl = if ($config.ContainsKey('CTI_LOCAL_LLM_BASE_URL')) { $config['CTI_LOCAL_LLM_BASE_URL'] } else { 'http://127.0.0.1:8080' }

Write-Output "config: $configPath"
Write-Output "base_url: $baseUrl"
Write-Output "server_exe: $serverExe"
Write-Output "model_path: $modelPath"
Write-Output "server_exe_exists: $(if ($serverExe) { Test-Path -LiteralPath $serverExe } else { $false })"
Write-Output "model_exists: $(if ($modelPath) { Test-Path -LiteralPath $modelPath } else { $false })"

if (-not $serverExe) {
    Write-Output 'missing: CTI_LOCAL_LLM_SERVER_EXE'
}
if (-not $modelPath) {
    Write-Output 'missing: CTI_LOCAL_LLM_MODEL_PATH'
}
