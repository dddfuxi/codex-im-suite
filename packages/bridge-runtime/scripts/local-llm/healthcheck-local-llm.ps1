$ErrorActionPreference = 'Stop'

$ctiHome = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$configPath = Join-Path $ctiHome 'config.env'

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
$baseUrl = if ($config.ContainsKey('CTI_LOCAL_LLM_BASE_URL')) { $config['CTI_LOCAL_LLM_BASE_URL'] } else { 'http://127.0.0.1:8080' }

$targets = @(
    "$baseUrl/health",
    "$baseUrl/v1/models",
    $baseUrl
)

foreach ($target in $targets) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $target -TimeoutSec 5
        Write-Output "online: $target ($($response.StatusCode))"
        exit 0
    } catch {
        $status = $_.Exception.Response.StatusCode.value__ 2>$null
        if ($status -in 400, 401, 403, 404, 405, 406) {
            Write-Output "online: $target ($status)"
            exit 0
        }
    }
}

throw "offline: $baseUrl"
