[CmdletBinding()]
param(
  [ValidateSet('session-start', 'stop')]
  [string]$Phase
)

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  $root = git rev-parse --show-toplevel 2>$null
  if (-not $root) {
    throw 'This script must run inside a Git repository.'
  }

  return (Resolve-Path $root).Path
}

function Read-ArchiveConfig {
  param([string]$RepoRoot)

  $configPath = Join-Path $RepoRoot 'config/git-session-archive.json'
  return Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Set-Utf8NoBomContent {
  param(
    [string]$Path,
    [string]$Value
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-CurrentBranch {
  $branch = git branch --show-current
  if (-not $branch) {
    return $null
  }

  return $branch.Trim()
}

function Get-Head {
  $head = git rev-parse HEAD 2>$null
  if (-not $head) {
    return $null
  }

  return $head.Trim()
}

function Get-StatusLines {
  $status = git status --porcelain=v1
  if (-not $status) {
    return @()
  }

  return @($status)
}

function Write-ArchiveEvent {
  param(
    [string]$StateDir,
    [string]$Event,
    [hashtable]$Data = @{}
  )

  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $payload = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    event = $Event
  }

  foreach ($key in $Data.Keys) {
    $payload[$key] = $Data[$key]
  }

  $line = ($payload | ConvertTo-Json -Compress -Depth 8)
  Add-Content -LiteralPath (Join-Path $StateDir 'events.jsonl') -Value $line -Encoding UTF8
}

function Test-BranchExists {
  param([string]$Branch)

  git show-ref --verify --quiet "refs/heads/$Branch"
  return $LASTEXITCODE -eq 0
}

function Get-BranchWorktreePath {
  param([string]$Branch)

  $currentWorktree = $null
  $targetRef = "refs/heads/$Branch"
  $lines = git worktree list --porcelain
  foreach ($line in $lines) {
    if ($line -match '^worktree (.+)$') {
      $currentWorktree = $Matches[1]
      continue
    }

    if ($line -eq "branch $targetRef") {
      return $currentWorktree
    }
  }

  return $null
}

function Invoke-ValidationCommands {
  param(
    [object[]]$Commands,
    [string]$StateDir
  )

  foreach ($command in $Commands) {
    if (-not $command) {
      continue
    }

    powershell -NoProfile -ExecutionPolicy Bypass -Command $command
    if ($LASTEXITCODE -ne 0) {
      Write-ArchiveEvent -StateDir $StateDir -Event 'validation-failed' -Data @{ command = $command; exitCode = $LASTEXITCODE }
      return $false
    }
  }

  return $true
}

function Save-SessionBaseline {
  param(
    [string]$StatePath,
    [string]$StateDir
  )

  $branch = Get-CurrentBranch
  $status = Get-StatusLines
  $state = [ordered]@{
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    branch = $branch
    head = Get-Head
    clean = $status.Count -eq 0
    statusCount = $status.Count
  }

  Set-Utf8NoBomContent -Path $StatePath -Value (($state | ConvertTo-Json -Depth 8) + "`n")
  Write-ArchiveEvent -StateDir $StateDir -Event 'session-start' -Data @{ branch = $branch; clean = $state.clean; statusCount = $state.statusCount }
}

function Complete-Session {
  param(
    [object]$Config,
    [string]$StatePath,
    [string]$StateDir
  )

  $policy = $Config.policy
  if (-not $policy.autoMerge) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'auto-merge-disabled'
    return
  }

  $targetBranch = $policy.autoMergeTargetBranch
  if (-not $targetBranch) {
    $targetBranch = 'codex/dev'
  }

  $sourceBranch = Get-CurrentBranch
  if (-not $sourceBranch) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-detached-head'
    return
  }

  if ($sourceBranch -eq $targetBranch) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-target-branch' -Data @{ branch = $sourceBranch }
    return
  }

  if (-not (Test-BranchExists -Branch $targetBranch)) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-missing-target' -Data @{ targetBranch = $targetBranch }
    return
  }

  if (-not (Test-Path -LiteralPath $StatePath)) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-missing-baseline' -Data @{ branch = $sourceBranch }
    return
  }

  $baseline = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($baseline.branch -ne $sourceBranch) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-branch-changed' -Data @{ baselineBranch = $baseline.branch; currentBranch = $sourceBranch }
    return
  }

  if ($policy.requireCleanBaseline -and -not $baseline.clean) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-dirty-baseline' -Data @{ branch = $sourceBranch; statusCount = $baseline.statusCount }
    return
  }

  $status = Get-StatusLines
  if ($status.Count -gt 0) {
    if (-not $policy.autoCommit) {
      Write-ArchiveEvent -StateDir $StateDir -Event 'skip-dirty-worktree' -Data @{ branch = $sourceBranch; statusCount = $status.Count }
      return
    }

    git add -A
    $staged = git diff --cached --name-only
    if ($staged) {
      $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
      git commit -m "archive: codex session $stamp"
      if ($LASTEXITCODE -ne 0) {
        Write-ArchiveEvent -StateDir $StateDir -Event 'auto-commit-failed' -Data @{ branch = $sourceBranch; exitCode = $LASTEXITCODE }
        return
      }
    }
  }

  $postCommitStatus = Get-StatusLines
  if ($postCommitStatus.Count -gt 0) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-dirty-after-commit' -Data @{ branch = $sourceBranch; statusCount = $postCommitStatus.Count }
    return
  }

  git diff --check "$targetBranch...HEAD"
  if ($LASTEXITCODE -ne 0) {
    Write-ArchiveEvent -StateDir $StateDir -Event 'target-diff-check-failed' -Data @{ sourceBranch = $sourceBranch; targetBranch = $targetBranch; exitCode = $LASTEXITCODE }
    return
  }

  if (-not (Invoke-ValidationCommands -Commands @($policy.validationCommands) -StateDir $StateDir)) {
    return
  }

  $sourceHead = Get-Head
  $targetWorktree = Get-BranchWorktreePath -Branch $targetBranch
  $temporaryWorktree = $false

  if (-not $targetWorktree) {
    $targetWorktree = Join-Path $StateDir ("merge-" + [Guid]::NewGuid().ToString('N'))
    git worktree add $targetWorktree $targetBranch
    if ($LASTEXITCODE -ne 0) {
      Write-ArchiveEvent -StateDir $StateDir -Event 'target-worktree-create-failed' -Data @{ targetBranch = $targetBranch; exitCode = $LASTEXITCODE }
      return
    }

    $temporaryWorktree = $true
  }

  $targetStatus = git -C $targetWorktree status --porcelain=v1
  if ($targetStatus) {
    if ($temporaryWorktree) {
      git worktree remove --force $targetWorktree 2>$null
    }

    Write-ArchiveEvent -StateDir $StateDir -Event 'skip-dirty-target-worktree' -Data @{ targetBranch = $targetBranch; targetWorktree = $targetWorktree; statusCount = @($targetStatus).Count }
    return
  }

  git -C $targetWorktree merge --no-ff --no-edit $sourceBranch
  if ($LASTEXITCODE -ne 0) {
    git -C $targetWorktree merge --abort 2>$null
    if ($temporaryWorktree) {
      git worktree remove --force $targetWorktree 2>$null
    }

    Write-ArchiveEvent -StateDir $StateDir -Event 'merge-failed' -Data @{ sourceBranch = $sourceBranch; targetBranch = $targetBranch; targetWorktree = $targetWorktree; exitCode = $LASTEXITCODE }
    return
  }

  $targetHead = git -C $targetWorktree rev-parse HEAD
  if ($temporaryWorktree) {
    git worktree remove --force $targetWorktree 2>$null
  }

  Write-ArchiveEvent -StateDir $StateDir -Event 'merged-to-target' -Data @{ sourceBranch = $sourceBranch; targetBranch = $targetBranch; sourceHead = $sourceHead; targetHead = $targetHead }
}

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

$config = Read-ArchiveConfig -RepoRoot $repoRoot
$stateDir = Join-Path $repoRoot '.entire/tmp/git-session-archive'
$statePath = Join-Path $stateDir 'current-session.json'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if ($Phase -eq 'session-start') {
  Save-SessionBaseline -StatePath $statePath -StateDir $stateDir
} else {
  Complete-Session -Config $config -StatePath $statePath -StateDir $stateDir
}
