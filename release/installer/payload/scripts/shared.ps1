$ErrorActionPreference = 'Stop'

function Get-SuiteRoot {
    return Split-Path -Parent $PSScriptRoot
}

function Get-SuiteManifest {
    param([string]$SuiteRoot)
    $manifestPath = Join-Path $SuiteRoot 'suite.manifest.json'
    return Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
}

function Get-CtiConfig {
    $path = Join-Path $env:USERPROFILE '.claude-to-im\config.env'
    $values = @{}
    if (-not (Test-Path -LiteralPath $path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
        if (-not $line -or $line.TrimStart().StartsWith('#')) { continue }
        $index = $line.IndexOf('=')
        if ($index -le 0) { continue }
        $values[$line.Substring(0, $index).Trim()] = $line.Substring($index + 1).Trim()
    }
    return $values
}

function Expand-SuiteValue {
    param(
        [string]$Value,
        [string]$SuiteRoot,
        [hashtable]$Config
    )
    if ($null -eq $Value) { return $null }
    $result = $Value
    $result = $result.Replace('${SUITE_ROOT}', $SuiteRoot)
    $result = $result.Replace('${CTI_HOME}', (Join-Path $env:USERPROFILE '.claude-to-im'))
    $result = $result.Replace('${USERPROFILE}', $env:USERPROFILE)
    foreach ($key in $Config.Keys) {
        $result = $result.Replace(('${' + $key + '}'), [string]$Config[$key])
    }
    return [Environment]::ExpandEnvironmentVariables($result)
}

function Get-GitText {
    param(
        [string]$SuiteRoot,
        [string[]]$GitArgs
    )

    Push-Location $SuiteRoot
    try {
        return (& git @GitArgs 2>$null) -join [Environment]::NewLine
    }
    finally {
        Pop-Location
    }
}

function Get-ReleaseFileHash {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return '<missing>'
    }

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Substring(0, 12)
}

function Get-ReleaseContentHash {
    param(
        [string[]]$Paths,
        [string[]]$ExcludeDirectories = @('node_modules', 'bin', 'obj', '.git', 'coverage', '.turbo', '.next', 'CodexImSuiteControlPanel.exe.WebView2')
    )

    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($path in $Paths) {
        if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) {
            $entries.Add("$path`n<missing>") | Out-Null
            continue
        }

        $item = Get-Item -LiteralPath $path
        if (-not $item.PSIsContainer) {
            $entries.Add("$($item.Name)`n$(Get-ReleaseFileHash -Path $item.FullName)") | Out-Null
            continue
        }

        $root = $item.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        Get-ChildItem -LiteralPath $root -Recurse -File -Force |
            Where-Object {
                $parts = $_.FullName.Substring($root.Length).TrimStart('\', '/') -split '[\\/]'
                foreach ($exclude in $ExcludeDirectories) {
                    if ($parts -contains $exclude) { return $false }
                }
                return $true
            } |
            Sort-Object FullName |
            ForEach-Object {
                $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
                $entries.Add("$relative`n$(Get-ReleaseFileHash -Path $_.FullName)") | Out-Null
            }
    }

    if ($entries.Count -eq 0) {
        return '<empty>'
    }

    $text = (@($entries) | Sort-Object) -join "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')).Substring(0, 12)
    }
    finally {
        $sha.Dispose()
    }
}

function Normalize-ReleaseManifestPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ''
    }

    $value = $Path.Trim().Replace('\', '/')
    while ($value.StartsWith('./')) {
        $value = $value.Substring(2)
    }
    return $value.TrimStart('/').TrimEnd('/')
}

function Add-ReleaseManifestDirectory {
    param(
        [System.Collections.Generic.List[string]]$Directories,
        [hashtable]$Seen,
        [object]$Value
    )

    foreach ($item in @($Value)) {
        $normalized = Normalize-ReleaseManifestPath -Path ([string]$item)
        if ([string]::IsNullOrWhiteSpace($normalized)) {
            continue
        }

        $key = $normalized.ToLowerInvariant()
        if (-not $Seen.ContainsKey($key)) {
            $Seen[$key] = $true
            $Directories.Add($normalized) | Out-Null
        }
    }
}

function Get-ReleaseManifestRelativeDirectories {
    param([string]$Root)

    $directories = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    $suiteManifestPath = Join-Path $Root 'suite.manifest.json'

    if (Test-Path -LiteralPath $suiteManifestPath -PathType Leaf) {
        $manifest = Get-Content -LiteralPath $suiteManifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
        Add-ReleaseManifestDirectory -Directories $directories -Seen $seen -Value $manifest.extensionProtocol.manifestDirs
        Add-ReleaseManifestDirectory -Directories $directories -Seen $seen -Value $manifest.actionProtocol.manifestDirs
        Add-ReleaseManifestDirectory -Directories $directories -Seen $seen -Value $manifest.actionProtocol.legacyManifestDirs
        Add-ReleaseManifestDirectory -Directories $directories -Seen $seen -Value $manifest.agentCollaborationProtocol.manifestDirs

        if ($null -ne $manifest.config) {
            foreach ($property in $manifest.config.PSObject.Properties) {
                if ($property.Name -match 'ManifestDirs?$') {
                    Add-ReleaseManifestDirectory -Directories $directories -Seen $seen -Value $property.Value
                }
            }
        }

        return $directories.ToArray()
    }

    # Live skill copies extension manifests to top-level *.d directories while
    # runtime/action manifests stay under config. Discover both layouts so the
    # release fingerprint stays sensitive even when suite.manifest.json is not
    # present in the target.
    $knownManifestDirs = @(
        'mcp.d',
        'skills.d',
        'plugins.d',
        'runtime.d',
        'action-manifests.d',
        'local-agent-tools.d',
        'agents.d'
    )
    foreach ($baseRelative in @('', 'config')) {
        $base = if ([string]::IsNullOrWhiteSpace($baseRelative)) { $Root } else { Join-Path $Root $baseRelative }
        if (-not (Test-Path -LiteralPath $base -PathType Container)) {
            continue
        }

        Get-ChildItem -LiteralPath $base -Filter '*.d' -Directory |
            Where-Object { ($knownManifestDirs -contains $_.Name) -or ($_.Name -like '*manifest*.d') } |
            ForEach-Object {
                $relative = if ([string]::IsNullOrWhiteSpace($baseRelative)) { $_.Name } else { "$baseRelative/$($_.Name)" }
                Add-ReleaseManifestDirectory -Directories $directories -Seen $seen -Value $relative
            }
    }

    return $directories.ToArray()
}

function Get-ReleaseManifestFileEntries {
    param([string]$Root)

    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($relativeDir in @(Get-ReleaseManifestRelativeDirectories -Root $Root)) {
        $physicalDir = Join-Path $Root ($relativeDir.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $physicalDir -PathType Container)) {
            continue
        }

        $canonicalDir = $relativeDir
        if (($canonicalDir -notlike 'config/*') -and ($canonicalDir -match '^[^/]+\.d$')) {
            $canonicalDir = "config/$canonicalDir"
        }

        $physicalRoot = (Get-Item -LiteralPath $physicalDir).FullName.TrimEnd('\', '/')
        Get-ChildItem -LiteralPath $physicalDir -Filter '*.json' -File |
            Sort-Object FullName |
            ForEach-Object {
                $fileRelative = $_.FullName.Substring($physicalRoot.Length).TrimStart('\', '/').Replace('\', '/')
                $entries.Add([pscustomobject]@{
                    FullName = $_.FullName
                    CanonicalPath = "$canonicalDir/$fileRelative"
                }) | Out-Null
            }
    }

    return $entries.ToArray()
}

function Get-ReleaseManifestHash {
    param([object[]]$Entries)

    if ($Entries.Count -eq 0) {
        return '<empty>'
    }

    $lines = @($Entries |
        Sort-Object CanonicalPath |
        ForEach-Object { "$($_.CanonicalPath)`n$(Get-ReleaseFileHash -Path $_.FullName)" })
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')).Substring(0, 12)
    }
    finally {
        $sha.Dispose()
    }
}

function Get-ReleaseManifestSummary {
    param([string]$Root)

    $manifestFiles = @(Get-ReleaseManifestFileEntries -Root $Root)
    $directories = @($manifestFiles |
        ForEach-Object { (Split-Path -Parent $_.CanonicalPath).Replace('\', '/') } |
        Sort-Object -Unique)

    return [pscustomobject]@{
        Count = $manifestFiles.Count
        Hash = Get-ReleaseManifestHash -Entries $manifestFiles
        Directories = $directories
    }
}

function Get-ReleasePanelSummary {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            Path = $Path
            Exists = $false
            Hash = '<missing>'
            Length = 0
            Modified = ''
        }
    }

    $item = Get-Item -LiteralPath $Path
    return [pscustomobject]@{
        Path = $item.FullName
        Exists = $true
        Hash = Get-ReleaseFileHash -Path $item.FullName
        Length = $item.Length
        Modified = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    }
}

function New-SuiteReleaseFingerprint {
    param(
        [string]$SuiteRoot,
        [string]$TargetName,
        [string]$TargetRole,
        [string]$ReleaseRunId,
        [object]$Content,
        [object]$ManifestSummary,
        [object]$PanelSummary
    )

    $manifest = Get-SuiteManifest -SuiteRoot $SuiteRoot
    $branch = (Get-GitText -SuiteRoot $SuiteRoot -GitArgs @('branch', '--show-current')).Trim()
    $commit = (Get-GitText -SuiteRoot $SuiteRoot -GitArgs @('rev-parse', '--short', 'HEAD')).Trim()
    $dirty = @((Get-GitText -SuiteRoot $SuiteRoot -GitArgs @('status', '--short')) -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    if ([string]::IsNullOrWhiteSpace($ReleaseRunId)) {
        $ReleaseRunId = if ($env:CTI_RELEASE_RUN_ID) { $env:CTI_RELEASE_RUN_ID } else { [guid]::NewGuid().ToString('N') }
    }

    return [pscustomobject]@{
        schema = 'codex-im-suite/release-fingerprint/v1'
        generatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        releaseRunId = $ReleaseRunId
        targetName = $TargetName
        targetRole = $TargetRole
        suite = [pscustomobject]@{
            name = [string]$manifest.name
            version = [string]$manifest.version
            extensionProtocol = [string]$manifest.extensionProtocol.id
            branch = $branch
            commit = $commit
            dirty = ($dirty.Count -gt 0)
        }
        manifest = $ManifestSummary
        panel = $PanelSummary
        content = [pscustomobject]$Content
    }
}

function Write-SuiteReleaseFingerprint {
    param(
        [string]$TargetRoot,
        [object]$Fingerprint
    )

    if (-not (Test-Path -LiteralPath $TargetRoot)) {
        New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
    }

    $path = Join-Path $TargetRoot '.suite-release.json'
    $Fingerprint | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Get-SuiteReleaseExpectedContentMap {
    param(
        [string]$SuiteRoot,
        [ValidateSet('LiveRuntime', 'LiveCore', 'Portable', 'InstallerPayload')]
        [string]$Layout
    )

    $runtimeRoot = Join-Path $SuiteRoot 'packages\bridge-runtime'
    $coreRoot = Join-Path $SuiteRoot 'packages\bridge-core'
    $panelRoot = if ($env:CTI_RELEASE_CONTROL_PANEL_DIR) {
        $env:CTI_RELEASE_CONTROL_PANEL_DIR
    } else {
        Join-Path $SuiteRoot 'release\artifacts\control-panel'
    }
    $runtimeDistExclude = @('node_modules', 'bin', 'obj', '.git', 'coverage', '.turbo', '.next', 'control-panel', 'release', 'CodexImSuiteControlPanel.exe.WebView2')

    $map = [ordered]@{}
    if ($Layout -in @('LiveRuntime', 'Portable', 'InstallerPayload')) {
        $map['runtime.package'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'package.json')
        $map['runtime.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $runtimeRoot 'dist')) -ExcludeDirectories $runtimeDistExclude
        $runtimeScriptPaths = @((Join-Path $runtimeRoot 'scripts'))
        if ($Layout -eq 'LiveRuntime') {
            $runtimeScriptPaths += (Join-Path $SuiteRoot 'scripts\export-glb-asset-package.ps1')
            $runtimeScriptPaths += (Join-Path $SuiteRoot 'scripts\export-glb-asset-package.py')
        }
        $map['runtime.scripts'] = Get-ReleaseContentHash -Paths $runtimeScriptPaths
        $map['runtime.configExample'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'config.env.example')
        $map['runtime.skill'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'SKILL.md')
        if ($Layout -eq 'LiveRuntime') {
            $map['runtime.manifests'] = (Get-ReleaseManifestSummary -Root $SuiteRoot).Hash
        }
        $map['panel.exe'] = Get-ReleaseFileHash -Path (Join-Path $panelRoot 'CodexImSuiteControlPanel.exe')
        $map['panel.wwwroot'] = Get-ReleaseContentHash -Paths @((Join-Path $panelRoot 'wwwroot'))
    }

    if ($Layout -in @('LiveCore', 'Portable', 'InstallerPayload')) {
        $map['core.package'] = Get-ReleaseFileHash -Path (Join-Path $coreRoot 'package.json')
        $map['core.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $coreRoot 'dist'))
    }

    if ($Layout -in @('Portable', 'InstallerPayload')) {
        $map['suite.manifest'] = Get-ReleaseFileHash -Path (Join-Path $SuiteRoot 'suite.manifest.json')
        $map['config.manifests'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'config'))
        $map['extensions.skills'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'extensions\skills'))
        $map['release.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'scripts'))
        $map['docs'] = Get-ReleaseContentHash -Paths @((Join-Path $SuiteRoot 'docs'))
    }

    return $map
}

function Get-SuiteReleaseActualContentMap {
    param(
        [string]$SuiteRoot,
        [string]$TargetRoot,
        [ValidateSet('LiveRuntime', 'LiveCore', 'Portable', 'InstallerPayload')]
        [string]$Layout
    )

    $runtimeDistExclude = @('node_modules', 'bin', 'obj', '.git', 'coverage', '.turbo', '.next', 'control-panel', 'release', 'CodexImSuiteControlPanel.exe.WebView2')
    $map = [ordered]@{}

    if ($Layout -eq 'LiveRuntime') {
        $map['runtime.package'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'package.json')
        $map['runtime.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'dist')) -ExcludeDirectories $runtimeDistExclude
        $map['runtime.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'scripts'))
        $map['runtime.configExample'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'config.env.example')
        $map['runtime.skill'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'SKILL.md')
        $map['runtime.manifests'] = (Get-ReleaseManifestSummary -Root $TargetRoot).Hash
        $map['panel.exe'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'dist\control-panel\CodexImSuiteControlPanel.exe')
        $map['panel.wwwroot'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'dist\control-panel\wwwroot'))
        return $map
    }

    if ($Layout -eq 'LiveCore') {
        $map['core.package'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'package.json')
        $map['core.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'dist'))
        return $map
    }

    $runtimeRoot = Join-Path $TargetRoot 'packages\bridge-runtime'
    $coreRoot = Join-Path $TargetRoot 'packages\bridge-core'
    $map['runtime.package'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'package.json')
    $map['runtime.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $runtimeRoot 'dist')) -ExcludeDirectories $runtimeDistExclude
    $map['runtime.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $runtimeRoot 'scripts'))
    $map['runtime.configExample'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'config.env.example')
    $map['runtime.skill'] = Get-ReleaseFileHash -Path (Join-Path $runtimeRoot 'SKILL.md')
    $map['core.package'] = Get-ReleaseFileHash -Path (Join-Path $coreRoot 'package.json')
    $map['core.dist'] = Get-ReleaseContentHash -Paths @((Join-Path $coreRoot 'dist'))
    $map['suite.manifest'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'suite.manifest.json')
    $map['config.manifests'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'config'))
    $map['extensions.skills'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'extensions\skills'))
    $map['release.scripts'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'scripts'))
    $map['docs'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'docs'))
    $map['panel.exe'] = Get-ReleaseFileHash -Path (Join-Path $TargetRoot 'CodexImSuiteControlPanel.exe')
    $map['panel.wwwroot'] = Get-ReleaseContentHash -Paths @((Join-Path $TargetRoot 'wwwroot'))
    return $map
}

function Read-SuiteReleaseFingerprint {
    param([string]$TargetRoot)

    $path = Join-Path $TargetRoot '.suite-release.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }

    return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Find-RunningProcessInPath {
    param([string[]]$Roots)

    $normalizedRoots = @($Roots |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar })

    if ($normalizedRoots.Count -eq 0) {
        return @()
    }

    $matches = New-Object System.Collections.Generic.List[object]
    foreach ($process in Get-Process) {
        $path = $null
        try {
            $path = $process.Path
        }
        catch {
            $path = $null
        }
        if ([string]::IsNullOrWhiteSpace($path)) { continue }

        $fullPath = [System.IO.Path]::GetFullPath($path)
        foreach ($root in $normalizedRoots) {
            if ($fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $matches.Add([pscustomobject]@{
                    Id = $process.Id
                    ProcessName = $process.ProcessName
                    Path = $fullPath
                    Root = $root.TrimEnd('\', '/')
                }) | Out-Null
            }
        }
    }

    return $matches.ToArray()
}

function Write-RunningProcessMatches {
    param(
        [object[]]$Matches
    )

    foreach ($match in $Matches) {
        Write-Host ("  PID {0} | {1} | {2}" -f $match.Id, $match.ProcessName, $match.Path)
    }
}

function Assert-NoRunningProcessInPath {
    param(
        [string[]]$Roots,
        [string]$Purpose = 'release operation'
    )

    $matches = @(Find-RunningProcessInPath -Roots $Roots)
    if ($matches.Count -eq 0) {
        return
    }

    Write-Host "Release process lock check failed: $Purpose"
    Write-RunningProcessMatches -Matches $matches
    throw "Running release/runtime copy process found. Close the listed process and retry; this script will not kill it automatically."
}

function Test-ReleaseForceUpdateEnabled {
    param([switch]$NoForceUpdate)

    if ($NoForceUpdate) {
        return $false
    }

    $value = [string]$env:CTI_RELEASE_FORCE_UPDATE
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $true
    }

    return -not @('0', 'false', 'no', 'off').Contains($value.Trim().ToLowerInvariant())
}

function Stop-RunningProcessInPath {
    param(
        [string[]]$Roots,
        [string]$Purpose = 'release operation',
        [int]$TimeoutSeconds = 20
    )

    $matches = @(Find-RunningProcessInPath -Roots $Roots)
    if ($matches.Count -eq 0) {
        return
    }

    Write-Host "Release process lock check: $Purpose"
    Write-Host "Force update is enabled; stopping running process(es) inside target path(s)."
    Write-RunningProcessMatches -Matches $matches

    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($match in $matches) {
        if (-not $seen.Add([int]$match.Id)) {
            continue
        }
        try {
            Stop-Process -Id ([int]$match.Id) -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "Failed to stop PID=$($match.Id): $($_.Exception.Message)"
        }
    }

    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
    do {
        Start-Sleep -Milliseconds 250
        $remaining = @(Find-RunningProcessInPath -Roots $Roots)
        if ($remaining.Count -eq 0) {
            Write-Host "Release process lock cleared: $Purpose"
            return
        }
    } while ((Get-Date) -lt $deadline)

    Write-Host "Release process lock check failed after force stop: $Purpose"
    Write-RunningProcessMatches -Matches $remaining
    throw "Running release/runtime copy process still exists after force stop."
}

function Clear-RunningProcessInPathForUpdate {
    param(
        [string[]]$Roots,
        [string]$Purpose = 'release operation',
        [int]$TimeoutSeconds = 20,
        [switch]$NoForceUpdate
    )

    if (Test-ReleaseForceUpdateEnabled -NoForceUpdate:$NoForceUpdate) {
        Stop-RunningProcessInPath -Roots $Roots -Purpose $Purpose -TimeoutSeconds $TimeoutSeconds
        return
    }

    Assert-NoRunningProcessInPath -Roots $Roots -Purpose $Purpose
}

function Clear-DeleteAttributes {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        $item.Attributes = 'Normal'
    }
    catch {
    }

    if (Test-Path -LiteralPath $Path -PathType Container) {
        Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object {
                try {
                    $_.Attributes = 'Normal'
                }
                catch {
                }
            }
    }
}

function Remove-PathForUpdate {
    param(
        [string]$Path,
        [string]$Purpose = 'release cleanup',
        [int]$RetryCount = 12,
        [int]$DelayMilliseconds = 500
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return
    }

    $lastError = $null
    for ($attempt = 1; $attempt -le [Math]::Max(1, $RetryCount); $attempt++) {
        try {
            Clear-DeleteAttributes -Path $Path
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            $lastError = $_.Exception.Message
            if ($attempt -ge [Math]::Max(1, $RetryCount)) {
                break
            }
            Write-Warning ("Cleanup retry {0}/{1} for {2}: {3}" -f $attempt, $RetryCount, $Purpose, $lastError)
            Start-Sleep -Milliseconds ([Math]::Max(50, $DelayMilliseconds))
        }
    }

    throw "无法清理更新目录：$Path。请确认没有资源管理器、杀毒软件或外部进程占用后重试。原始错误：$lastError"
}
