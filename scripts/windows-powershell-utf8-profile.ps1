param(
    [ValidateSet('Apply', 'Check', 'Remove')]
    [string]$Mode = 'Check',
    [string]$ProfilePath = '',
    [string]$PowerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
)

$ErrorActionPreference = 'Stop'

$beginMarker = '# BEGIN codex-im-suite PowerShell UTF-8'
$endMarker = '# END codex-im-suite PowerShell UTF-8'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$expectedProbeHex = 'e4b8ade69687e6b58be8af950d0a'
$expectedFileProbeHex = 'e4b8ade69687e6b58be8af95'

if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
    $ProfilePath = $PROFILE.CurrentUserAllHosts
}
$ProfilePath = [System.IO.Path]::GetFullPath($ProfilePath)

function Get-ManagedBlock {
    param([bool]$OriginalEndedWithNewline)

    $newlineFlag = if ($OriginalEndedWithNewline) { 'true' } else { 'false' }
    return @"
$beginMarker original-ended-with-newline=$newlineFlag
`$OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList `$false
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList `$false } catch {}
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList `$false } catch {}
`$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'
$endMarker
"@ -replace "`n", "`r`n"
}

function Read-ProfileText {
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) {
        return ''
    }
    return [System.IO.File]::ReadAllText($ProfilePath, [System.Text.Encoding]::UTF8)
}

function Find-ManagedBlock {
    param([string]$Content)

    $start = $Content.IndexOf($beginMarker, [System.StringComparison]::Ordinal)
    if ($start -lt 0) {
        return $null
    }
    $endMarkerIndex = $Content.IndexOf($endMarker, $start, [System.StringComparison]::Ordinal)
    if ($endMarkerIndex -lt 0) {
        throw 'PowerShell UTF-8 managed block is incomplete; refusing to rewrite it automatically.'
    }
    $end = $endMarkerIndex + $endMarker.Length
    if ($Content.Length -ge ($end + 2) -and $Content.Substring($end, 2) -eq "`r`n") {
        $end += 2
    } elseif ($Content.Length -gt $end -and $Content[$end] -eq "`n") {
        $end += 1
    }

    $firstLineEnd = $Content.IndexOf("`n", $start)
    if ($firstLineEnd -lt 0) { $firstLineEnd = $endMarkerIndex }
    $firstLine = $Content.Substring($start, $firstLineEnd - $start).TrimEnd("`r")
    [pscustomobject]@{
        Start = $start
        End = $end
        OriginalEndedWithNewline = $firstLine.EndsWith('original-ended-with-newline=true', [System.StringComparison]::Ordinal)
    }
}

function Remove-ManagedBlock {
    param([string]$Content)

    $block = Find-ManagedBlock -Content $Content
    if ($null -eq $block) {
        return $Content
    }

    $start = $block.Start
    if (-not $block.OriginalEndedWithNewline) {
        if ($start -ge 2 -and $Content.Substring($start - 2, 2) -eq "`r`n") {
            $start -= 2
        } elseif ($start -ge 1 -and $Content[$start - 1] -eq "`n") {
            $start -= 1
        }
    }
    return $Content.Substring(0, $start) + $Content.Substring($block.End)
}

function Write-ProfileText {
    param([string]$Content)

    $parent = Split-Path -Parent $ProfilePath
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    [System.IO.File]::WriteAllText($ProfilePath, $Content, $utf8NoBom)
}

function Invoke-Utf8StdinProbe {
    if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) {
        throw "Windows PowerShell executable not found: $PowerShellPath"
    }
    $nodeCommand = Get-Command node -ErrorAction Stop
    $escapedProfile = $ProfilePath.Replace("'", "''")
    $escapedNode = $nodeCommand.Source.Replace("'", "''")
    $command = "`$ProgressPreference = 'SilentlyContinue'; . '$escapedProfile'; `$probeText = -join @([char]0x4e2d, [char]0x6587, [char]0x6d4b, [char]0x8bd5); `$probeText | & '$escapedNode' -e `"const fs=require('fs');process.stdout.write(fs.readFileSync(0).toString('hex'))`""
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $PowerShellPath
        $startInfo.Arguments = "-NoLogo -NoProfile -EncodedCommand $encodedCommand"
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "UTF-8 stdin probe process failed: $stderr"
        }
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            throw "UTF-8 stdin probe returned no stdout. stderr=$stderr"
        }
        return $stdout.Trim().ToLowerInvariant()
    }
    finally {}
}

function Invoke-Utf8DefaultFileReadProbe {
    if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) {
        throw "Windows PowerShell executable not found: $PowerShellPath"
    }
    $probePath = [System.IO.Path]::GetTempFileName()
    try {
        $probeText = -join @([char]0x4e2d, [char]0x6587, [char]0x6d4b, [char]0x8bd5)
        [System.IO.File]::WriteAllText($probePath, $probeText, $utf8NoBom)
        $escapedProfile = $ProfilePath.Replace("'", "''")
        $escapedProbe = $probePath.Replace("'", "''")
        $command = "`$ProgressPreference = 'SilentlyContinue'; . '$escapedProfile'; `$text = Get-Content -Raw -LiteralPath '$escapedProbe'; [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes(`$text)).Replace('-', '').ToLowerInvariant()"
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $PowerShellPath
        $startInfo.Arguments = "-NoLogo -NoProfile -EncodedCommand $encodedCommand"
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "UTF-8 default file read probe process failed: $stderr"
        }
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            throw "UTF-8 default file read probe returned no stdout. stderr=$stderr"
        }
        return $stdout.Trim().ToLowerInvariant()
    }
    finally {
        if (Test-Path -LiteralPath $probePath) {
            Remove-Item -LiteralPath $probePath -Force
        }
    }
}

$beforeExists = Test-Path -LiteralPath $ProfilePath -PathType Leaf
$beforeContent = Read-ProfileText

switch ($Mode) {
    'Check' {
        $block = Find-ManagedBlock -Content $beforeContent
        if ($null -eq $block) {
            Write-Host "powershell-utf8=missing profile=$ProfilePath"
            exit 1
        }
        $probe = Invoke-Utf8StdinProbe
        if ($probe -ne $expectedProbeHex) {
            Write-Host "powershell-utf8=failed probe=$probe"
            exit 1
        }
        $fileProbe = Invoke-Utf8DefaultFileReadProbe
        if ($fileProbe -ne $expectedFileProbeHex) {
            Write-Host "powershell-utf8=failed file-probe=$fileProbe"
            exit 1
        }
        Write-Host "powershell-utf8=healthy probe=$probe file-probe=$fileProbe profile=$ProfilePath"
        exit 0
    }
    'Apply' {
        $withoutManagedBlock = Remove-ManagedBlock -Content $beforeContent
        $endedWithNewline = $withoutManagedBlock.EndsWith("`n", [System.StringComparison]::Ordinal)
        $separator = if ($withoutManagedBlock.Length -gt 0 -and -not $endedWithNewline) { "`r`n" } else { '' }
        $nextContent = $withoutManagedBlock + $separator + (Get-ManagedBlock -OriginalEndedWithNewline $endedWithNewline)

        if ($nextContent -ne $beforeContent) {
            if ($beforeExists) {
                $backupPath = "$ProfilePath.codex-im-suite.$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')).bak"
                [System.IO.File]::WriteAllText($backupPath, $beforeContent, $utf8NoBom)
                Write-Host "backup=$backupPath"
            }
            Write-ProfileText -Content $nextContent
        }

        try {
            $probe = Invoke-Utf8StdinProbe
            if ($probe -ne $expectedProbeHex) {
                throw "unexpected probe bytes: $probe"
            }
            $fileProbe = Invoke-Utf8DefaultFileReadProbe
            if ($fileProbe -ne $expectedFileProbeHex) {
                throw "unexpected default file read probe bytes: $fileProbe"
            }
        }
        catch {
            if ($beforeExists) {
                Write-ProfileText -Content $beforeContent
            } elseif (Test-Path -LiteralPath $ProfilePath) {
                Remove-Item -LiteralPath $ProfilePath -Force
            }
            throw "PowerShell UTF-8 profile probe failed; before-image restored. $($_.Exception.Message)"
        }

        Write-Host "powershell-utf8=applied probe=$probe file-probe=$fileProbe profile=$ProfilePath"
        exit 0
    }
    'Remove' {
        $nextContent = Remove-ManagedBlock -Content $beforeContent
        if ($nextContent -ne $beforeContent) {
            Write-ProfileText -Content $nextContent
        }
        Write-Host "powershell-utf8=removed profile=$ProfilePath"
        exit 0
    }
}
