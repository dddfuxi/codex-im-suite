import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { removeManagedTempDirectorySafely, resolveExecutableDependency } from '../speech/dependency-resolution.js';

describe('speech dependency resolution', () => {
  it('fails closed for a bad explicit path instead of falling back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-deps-'));
    try {
      const result = resolveExecutableDependency({
        id: 'ffmpeg',
        displayName: 'FFmpeg',
        explicitPath: path.join(root, 'missing-ffmpeg.exe'),
        runtimeDepsRoot: root,
      });
      assert.equal(result.state, 'blocked');
      assert.equal(result.source, 'explicit');
      assert.equal(result.diagnosticCode, 'explicit_path_missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers CTI_HOME runtime-deps before PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-managed-'));
    const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const versionRoot = path.join(root, 'speech', 'ffmpeg', 'v1');
    const managed = path.join(versionRoot, 'bin', executableName);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, 'managed', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(managed, 0o700);
    fs.writeFileSync(path.join(versionRoot, '.installed.json'), JSON.stringify({
      protocol: 'cti-speech-component-install/v1',
      id: 'ffmpeg',
      version: 'v1',
      sha256: 'a'.repeat(64),
      size: 7,
      source: 'https://example.invalid/ffmpeg',
      license: 'test',
      platform: `${process.platform}-${process.arch}`,
      entryPoint: `bin/${executableName}`,
      entryPointSha256: crypto.createHash('sha256').update('managed').digest('hex'),
      entryPointSize: Buffer.byteLength('managed'),
      installedAt: '2026-08-07T00:00:00.000Z',
    }), 'utf8');
    try {
      const result = resolveExecutableDependency({ id: 'ffmpeg', displayName: 'FFmpeg', runtimeDepsRoot: root });
      assert.equal(result.state, 'ready');
      assert.equal(result.source, 'managed');
      assert.equal(result.path, path.resolve(managed));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('only recursively removes an ordinary direct child with the required prefix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-cleanup-'));
    const target = path.join(root, 'asr-owned');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'input.wav'), 'audio', 'utf8');
    try {
      assert.throws(() => removeManagedTempDirectorySafely({
        targetPath: target,
        managedRoot: root,
        requiredNamePrefix: '.stage-',
      }), /managed_cleanup_target_invalid/);
      assert.equal(fs.existsSync(target), true);
      removeManagedTempDirectorySafely({ targetPath: target, managedRoot: root, requiredNamePrefix: 'asr-' });
      assert.equal(fs.existsSync(target), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a target replaced by a junction/symlink before the atomic quarantine rename', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-cleanup-race-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-cleanup-outside-'));
    const target = path.join(root, 'asr-owned');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep', 'utf8');
    const originalRename = fs.renameSync;
    let replaced = false;
    try {
      try {
        const probe = path.join(root, 'probe-link');
        fs.symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
        fs.unlinkSync(probe);
      } catch {
        context.skip('当前环境不允许创建 junction/symlink');
        return;
      }
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (!replaced && path.resolve(String(oldPath)) === path.resolve(target)) {
          replaced = true;
          fs.rmdirSync(target);
          fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
        }
        return originalRename(oldPath, newPath);
      }) as typeof fs.renameSync;
      assert.throws(() => removeManagedTempDirectorySafely({
        targetPath: target,
        managedRoot: root,
        requiredNamePrefix: 'asr-',
      }), /managed_cleanup_identity_changed/);
      assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores an unmarked or damaged managed version directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-untrusted-managed-'));
    const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const versionRoot = path.join(root, 'speech', 'ffmpeg', 'v1');
    const managed = path.join(versionRoot, 'bin', executableName);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, 'managed', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(managed, 0o700);
    try {
      const unmarked = resolveExecutableDependency({ id: 'ffmpeg', displayName: 'FFmpeg', runtimeDepsRoot: root });
      assert.notEqual(unmarked.path, path.resolve(managed));
      fs.writeFileSync(path.join(versionRoot, '.installed.json'), '{"protocol":"fake"}', 'utf8');
      const forged = resolveExecutableDependency({ id: 'ffmpeg', displayName: 'FFmpeg', runtimeDepsRoot: root });
      assert.notEqual(forged.path, path.resolve(managed));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an explicit dependency traverses a junction/symlink ancestor', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reparse-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reparse-target-'));
    const executableName = process.platform === 'win32' ? 'tool.exe' : 'tool';
    const outsideFile = path.join(outside, executableName);
    fs.writeFileSync(outsideFile, 'tool', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(outsideFile, 0o700);
    const linked = path.join(root, 'linked');
    try {
      try {
        fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        context.skip('当前环境不允许创建 junction/symlink');
        return;
      }
      const result = resolveExecutableDependency({
        id: 'tool',
        displayName: 'Tool',
        explicitPath: path.join(linked, executableName),
        runtimeDepsRoot: root,
      });
      assert.equal(result.state, 'blocked');
      assert.equal(result.source, 'explicit');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
