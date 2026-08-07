import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const suiteRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(suiteRoot, 'scripts', 'windows-powershell-utf8-profile.ps1');
const powershellPath = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function runProfileScript(mode, profilePath) {
  return spawnSync(
    powershellPath,
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Mode',
      mode,
      '-ProfilePath',
      profilePath,
      '-PowerShellPath',
      powershellPath,
    ],
    { encoding: 'utf8' },
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('PowerShell 5.1 UTF-8 profile supports check apply idempotency probe and remove', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cti-powershell-utf8-'));
  const profilePath = path.join(tempRoot, 'Microsoft.PowerShell_profile.ps1');
  const customLine = "Set-Alias -Name cti_keep -Value Get-ChildItem`r`n";
  await writeFile(profilePath, customLine, 'utf8');

  const before = runProfileScript('Check', profilePath);
  assert.notEqual(before.status, 0, `initial Check should fail:\n${before.stdout}\n${before.stderr}`);

  const applied = runProfileScript('Apply', profilePath);
  assert.equal(applied.status, 0, `Apply failed:\n${applied.stdout}\n${applied.stderr}`);
  assert.match(applied.stdout, /e4b8ade69687e6b58be8af950d0a/i);

  const firstContent = await readFile(profilePath, 'utf8');
  assert.match(firstContent, /BEGIN codex-im-suite PowerShell UTF-8/);
  assert.match(firstContent, /\$OutputEncoding/);
  assert.match(firstContent, /PSDefaultParameterValues\['Get-Content:Encoding'\]\s*=\s*'UTF8'/);
  assert.match(firstContent, /Set-Alias -Name cti_keep/);

  const appliedAgain = runProfileScript('Apply', profilePath);
  assert.equal(appliedAgain.status, 0, `second Apply failed:\n${appliedAgain.stdout}\n${appliedAgain.stderr}`);
  const secondContent = await readFile(profilePath, 'utf8');
  assert.equal(sha256(secondContent), sha256(firstContent));

  const checked = runProfileScript('Check', profilePath);
  assert.equal(checked.status, 0, `Check after Apply failed:\n${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /e4b8ade69687e6b58be8af950d0a/i);
  assert.match(checked.stdout, /file-probe=e4b8ade69687e6b58be8af95/i);

  const removed = runProfileScript('Remove', profilePath);
  assert.equal(removed.status, 0, `Remove failed:\n${removed.stdout}\n${removed.stderr}`);
  const finalContent = await readFile(profilePath, 'utf8');
  assert.equal(finalContent, customLine);
});

test('Apply restores the exact before-image when the real stdin probe cannot run', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cti-powershell-utf8-rollback-'));
  const profilePath = path.join(tempRoot, 'Microsoft.PowerShell_profile.ps1');
  const original = "function Keep-UserProfile { '保留用户内容' }`r`n";
  await writeFile(profilePath, original, 'utf8');

  const result = spawnSync(
    powershellPath,
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Mode',
      'Apply',
      '-ProfilePath',
      profilePath,
      '-PowerShellPath',
      path.join(tempRoot, 'missing-powershell.exe'),
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.equal(await readFile(profilePath, 'utf8'), original);
});

test('bootstrap applies and doctor checks the managed PowerShell UTF-8 profile through PSScriptRoot', async () => {
  const bootstrap = await readFile(path.join(suiteRoot, 'scripts', 'bootstrap-suite.ps1'), 'utf8');
  const doctor = await readFile(path.join(suiteRoot, 'scripts', 'doctor-suite-targets.ps1'), 'utf8');

  assert.match(bootstrap, /windows-powershell-utf8-profile\.ps1/);
  assert.match(bootstrap, /-Mode\s+Apply/);
  assert.match(bootstrap, /\$PSScriptRoot/);
  assert.doesNotMatch(bootstrap, /C:\\Users\\admin/i);

  assert.match(doctor, /windows-powershell-utf8-profile\.ps1/);
  assert.match(doctor, /-Mode\s+Check/);
  assert.match(doctor, /powershell-utf8/);
  assert.match(doctor, /\$PSScriptRoot/);
  assert.doesNotMatch(doctor, /C:\\Users\\admin/i);
});
