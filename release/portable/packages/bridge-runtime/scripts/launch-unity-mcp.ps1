param(
    [string]$Endpoint = "http://127.0.0.1:8081/mcp",
    [int]$TimeoutSeconds = 1
)

$ErrorActionPreference = 'Stop'

function Exit-Fail {
    param([string]$Message)
    Write-Output "MCP_FAIL $Message"
    exit 1
}

function Exit-Ok {
    param([string]$Message)
    Write-Output "MCP_READY $Message"
    exit 0
}

function Test-McpEndpoint {
    param(
        [string]$Url,
        [int]$TimeoutSec
    )
    $uri = $null
    try {
        $uri = [System.Uri]$Url
        $client = [System.Net.Sockets.TcpClient]::new()
        $connect = $client.ConnectAsync($uri.Host, $uri.Port)
        if (-not $connect.Wait([Math]::Max(250, $TimeoutSec * 1000))) {
            $client.Close()
            return @{ ok = $false; detail = "tcp timeout" }
        }
        $client.Close()

        $initBody = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"claude-to-im-unity-mcp-precheck","version":"0.0.0"}}}'
        $init = Invoke-WebRequest `
            -Uri $Url `
            -Method Post `
            -Headers @{ Accept = 'application/json, text/event-stream' } `
            -ContentType 'application/json' `
            -Body $initBody `
            -TimeoutSec ([Math]::Max(2, $TimeoutSec)) `
            -UseBasicParsing
        $sessionId = $init.Headers['mcp-session-id']
        if (-not $sessionId) {
            return @{ ok = $false; detail = "MCP initialize OK but missing mcp-session-id" }
        }

        $instancesBody = '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"mcpforunity://instances"}}'
        $instances = Invoke-WebRequest `
            -Uri $Url `
            -Method Post `
            -Headers @{ Accept = 'application/json, text/event-stream'; 'mcp-session-id' = $sessionId } `
            -ContentType 'application/json' `
            -Body $instancesBody `
            -TimeoutSec ([Math]::Max(2, $TimeoutSec)) `
            -UseBasicParsing
        $content = [string]$instances.Content
        if ($content -match 'Unity session not available|No Unity instance|not available|unavailable') {
            return @{ ok = $false; detail = "MCP protocol OK but Unity session unavailable" }
        }
        if ($content -match '"instance_count"\s*:\s*([1-9][0-9]*)') {
            return @{ ok = $true; detail = "MCP protocol OK; Unity instance_count=$($Matches[1])" }
        }
        return @{ ok = $false; detail = "MCP protocol OK but Unity instances response is empty or unknown" }
    }
    catch {
        $response = $_.Exception.Response
        if ($response) {
            return @{ ok = $false; detail = "HTTP $([int]$response.StatusCode)" }
        }
        return @{ ok = $false; detail = $_.Exception.Message }
    }
}

function Get-UnityCandidateUrls {
    param([string]$PrimaryEndpoint)
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $urls = New-Object System.Collections.Generic.List[string]

    if ($PrimaryEndpoint -and $seen.Add($PrimaryEndpoint)) { $urls.Add($PrimaryEndpoint) }
    foreach ($base in @('http://127.0.0.1:8081/mcp', 'http://127.0.0.1:8080/mcp', 'http://127.0.0.1:8080')) {
        if ($seen.Add($base)) { $urls.Add($base) }
    }

    return $urls
}

function Find-UnityEditorExe {
    if ($env:CTI_UNITY_EDITOR_EXE -and (Test-Path $env:CTI_UNITY_EDITOR_EXE)) {
        return $env:CTI_UNITY_EDITOR_EXE
    }

    $runningUnity = Get-Process -Name Unity -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Path -ErrorAction SilentlyContinue |
        Where-Object { $_ -and (Test-Path $_) } |
        Select-Object -First 1
    if ($runningUnity) {
        return $runningUnity
    }

    $candidateRoots = @(
        "C:\Program Files\Unity\Hub\Editor",
        "C:\Program Files\Unity\Editor"
    )
    foreach ($root in $candidateRoots) {
        if (-not (Test-Path $root)) { continue }
        $exe = Get-ChildItem -Path $root -Recurse -File -Filter "Unity.exe" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($exe) { return $exe.FullName }
    }
    return $null
}

function Test-UnityProjectPath {
    param([string]$PathValue)
    if (-not $PathValue) { return $false }
    if (-not (Test-Path $PathValue)) { return $false }
    $assets = Join-Path $PathValue 'Assets'
    $settings = Join-Path $PathValue 'ProjectSettings'
    return (Test-Path $assets) -and (Test-Path $settings)
}

function Resolve-UnityProjectPath {
    $candidates = New-Object System.Collections.Generic.List[string]

    if ($env:CTI_UNITY_PROJECT_PATH) { $candidates.Add($env:CTI_UNITY_PROJECT_PATH) }
    if ($env:CTI_DEFAULT_WORKDIR) { $candidates.Add($env:CTI_DEFAULT_WORKDIR) }
    $candidates.Add((Get-Location).Path)

    foreach ($candidate in $candidates) {
        if (Test-UnityProjectPath $candidate) { return $candidate }
    }

    return $null
}

function Normalize-ProjectPath {
    param([string]$PathValue)
    if (-not $PathValue) { return $null }
    try {
        return [System.IO.Path]::GetFullPath($PathValue).TrimEnd('\').ToLowerInvariant()
    } catch {
        return $null
    }
}

function Get-UnityProcessForProject {
    param([string]$ProjectPath)
    $target = Normalize-ProjectPath $ProjectPath
    if (-not $target) { return $null }

    $unityProcesses = Get-CimInstance Win32_Process -Filter "Name = 'Unity.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $unityProcesses) {
        $cmd = [string]$proc.CommandLine
        if (-not $cmd) { continue }

        $match = [regex]::Match($cmd, '(?i)-projectPath\s+("([^"]+)"|(\S+))')
        if (-not $match.Success) { continue }
        $rawPath = if ($match.Groups[2].Success) { $match.Groups[2].Value } else { $match.Groups[3].Value }
        $openedPath = Normalize-ProjectPath $rawPath
        if ($openedPath -and $openedPath -eq $target) {
            return $proc
        }
    }
    return $null
}

function Get-McpBaseUrl {
    param([string]$McpEndpoint)
    if (-not $McpEndpoint) { return "http://127.0.0.1:8081" }
    if ($McpEndpoint.EndsWith('/mcp')) {
        return $McpEndpoint.Substring(0, $McpEndpoint.Length - 4).TrimEnd('/')
    }
    return $McpEndpoint.TrimEnd('/')
}

function Request-UnityMcpAutoStart {
    param(
        [string]$ProjectPath,
        [string]$McpEndpoint
    )

    $packageDir = Join-Path $ProjectPath 'Packages\MCPForUnity'
    $autoStartHandler = Join-Path $packageDir 'Editor\Services\HttpAutoStartHandler.cs'
    if (-not (Test-Path $autoStartHandler)) {
        Write-Output "MCP_INFO MCPForUnity package not found at $packageDir"
        return $false
    }

    $requestDir = Join-Path $ProjectPath 'Library\MCPForUnity'
    New-Item -ItemType Directory -Force -Path $requestDir | Out-Null
    $baseUrl = Get-McpBaseUrl -McpEndpoint $McpEndpoint
    $requestFile = Join-Path $requestDir 'http-autostart.request'
    @(
        "requestedAt=$(Get-Date -Format o)",
        "baseUrl=$baseUrl",
        "reason=claude-to-im-unity-mcp-precheck"
    ) | Set-Content -LiteralPath $requestFile -Encoding ASCII

    # Touch the editor script so an already-open Unity project reloads the MCP package
    # and consumes the request file without launching a second Unity instance.
    (Get-Item -LiteralPath $autoStartHandler).LastWriteTime = Get-Date
    Write-Output "MCP_INFO requested MCPForUnity HTTP autostart via $requestFile"
    return $true
}

function Get-McpForUnityServerSource {
    param([string]$ProjectPath)
    $packageJson = Join-Path $ProjectPath 'Packages\MCPForUnity\package.json'
    if (-not (Test-Path $packageJson)) { return "mcpforunityserver" }

    try {
        $pkg = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
        if ($pkg.version) { return "mcpforunityserver==$($pkg.version)" }
    } catch { }

    return "mcpforunityserver"
}

function Start-McpHttpServerDirect {
    param(
        [string]$ProjectPath,
        [string]$McpEndpoint
    )

    $uvx = (Get-Command uvx -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
    if (-not $uvx) {
        Write-Output "MCP_INFO uvx not found; skip direct MCP server launch"
        return $false
    }

    $baseUrl = Get-McpBaseUrl -McpEndpoint $McpEndpoint
    $source = Get-McpForUnityServerSource -ProjectPath $ProjectPath
    $logDir = Join-Path $env:USERPROFILE '.claude-to-im\runtime\unity-mcp'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stdout = Join-Path $logDir 'mcp-for-unity.out.log'
    $stderr = Join-Path $logDir 'mcp-for-unity.err.log'

    $args = @(
        '--from', $source,
        'mcp-for-unity',
        '--transport', 'http',
        '--http-url', $baseUrl,
        '--project-scoped-tools'
    )

    try {
        $proc = Start-Process -FilePath $uvx -ArgumentList $args -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
        Write-Output "MCP_INFO started direct mcp-for-unity server PID=$($proc.Id) source=$source url=$baseUrl/mcp"
        return $true
    } catch {
        Write-Output "MCP_INFO direct mcp-for-unity launch failed: $($_.Exception.Message)"
        return $false
    }
}

$probe = Test-McpEndpoint -Url $Endpoint -TimeoutSec $TimeoutSeconds
if ($probe.ok) {
    Exit-Ok "endpoint=$Endpoint detail=$($probe.detail)"
}

$projectPath = Resolve-UnityProjectPath
if (-not $projectPath) {
    Exit-Fail "no valid Unity project path found (need Assets and ProjectSettings). Set CTI_UNITY_PROJECT_PATH."
}

$unityExe = Find-UnityEditorExe
if (-not $unityExe) {
    Exit-Fail "Unity editor not found. Set CTI_UNITY_EDITOR_EXE."
}

$openedProc = Get-UnityProcessForProject -ProjectPath $projectPath
$didLaunchUnity = $false
if ($openedProc) {
    Write-Output "MCP_INFO project already open in Unity process PID=$($openedProc.ProcessId), skip relaunch."
} else {
    Start-Process -FilePath $unityExe -ArgumentList "-projectPath `"$projectPath`"" -WindowStyle Minimized | Out-Null
    Start-Sleep -Seconds 8
    $didLaunchUnity = $true
}

$requestedAutoStart = Request-UnityMcpAutoStart -ProjectPath $projectPath -McpEndpoint $Endpoint
$startedDirectServer = Start-McpHttpServerDirect -ProjectPath $projectPath -McpEndpoint $Endpoint
$maxAttempts = if ($requestedAutoStart) { 8 } else { 3 }
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    foreach ($candidate in (Get-UnityCandidateUrls -PrimaryEndpoint $Endpoint)) {
        $probeAfter = Test-McpEndpoint -Url $candidate -TimeoutSec $TimeoutSeconds
        if ($probeAfter.ok) {
            Exit-Ok "endpoint=$candidate detail=$($probeAfter.detail)"
        }
    }

    if ($attempt -lt $maxAttempts) {
        Write-Output "MCP_INFO waiting for MCPForUnity HTTP server attempt=$attempt/$maxAttempts"
        Start-Sleep -Seconds 3
    }
}

if ($didLaunchUnity) {
    Exit-Fail "Unity launched and autostart was requested, but MCP is still offline. Check Unity Console for MCPForUnity compile/start errors."
} else {
    Exit-Fail "Project already open and autostart was requested, but MCP is still offline. Check Unity Console for MCPForUnity compile/start errors."
}
