import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assertSafeZipEntryName, ManagedSpeechDependencyManager } from '../speech/managed-dependency-manager.js';

describe('managed speech dependency archive safety', () => {
  it('rejects Zip Slip, absolute, drive and backslash paths', () => {
    for (const candidate of ['../escape.bin', '/absolute.bin', 'C:/escape.bin', 'dir\\escape.bin']) {
      assert.throws(() => assertSafeZipEntryName(candidate), /archive_path_unsafe/);
    }
    assert.equal(assertSafeZipEntryName('model/files/weights.bin'), 'model/files/weights.bin');
  });

  it('blocks platform-specific archives on a different runtime before download', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-platform-'));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      protocol: 'cti-speech-managed-dependencies/v1',
      components: [{
        id: 'runtime_win32', displayName: 'Windows Runtime', kind: 'binary', capabilities: ['asr_runtime'],
        source: 'https://example.invalid/runtime.zip', version: 'v1', sha256: 'a'.repeat(64), size: 123,
        license: 'Apache-2.0', archive: 'zip', fileName: 'runtime.exe', availability: 'ready', platforms: ['win32-x64'],
      }],
    }), 'utf8');
    try {
      const manager = new ManagedSpeechDependencyManager(manifestPath, path.join(root, 'deps'), undefined, 'linux-x64');
      const status = manager.listStatuses()[0];
      assert.equal(status.state, 'blocked');
      assert.equal(status.installable, false);
      assert.equal(status.diagnosticCode, 'component_platform_unsupported');
      await assert.rejects(manager.install('runtime_win32'), /component_platform_unsupported/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes only pinned SenseVoice assets as installable and keeps CosyVoice blocked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-manifest-'));
    const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../speech/managed-dependencies.json');
    try {
      const manager = new ManagedSpeechDependencyManager(manifestPath, path.join(root, 'deps'), undefined, 'win32-x64');
      const statuses = new Map(manager.listStatuses().map((item) => [item.id, item]));
      assert.equal(statuses.get('sensevoice_gguf')?.installable, true);
      assert.equal(statuses.get('sensevoice_runtime')?.installable, true);
      assert.equal(statuses.get('cosyvoice')?.state, 'blocked');
      assert.equal(statuses.get('cosyvoice_clone')?.diagnosticCode, 'manifest_incomplete');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a complete matching marker and a real declared entry point', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-marker-'));
    const manifestPath = path.join(root, 'manifest.json');
    const depsRoot = path.join(root, 'deps');
    const versionRoot = path.join(depsRoot, 'speech', 'test_component', 'v1');
    const entryPoint = path.join(versionRoot, 'bin', 'runtime.exe');
    const component = {
      id: 'test_component', displayName: 'Test Component', kind: 'binary', capabilities: ['test'],
      source: 'https://example.invalid/runtime.zip', version: 'v1', sha256: 'b'.repeat(64), size: 123,
      license: 'Apache-2.0', archive: 'zip', fileName: 'bin/runtime.exe', availability: 'ready',
      platforms: ['win32-x64'],
    };
    fs.writeFileSync(manifestPath, JSON.stringify({
      protocol: 'cti-speech-managed-dependencies/v1', components: [component],
    }), 'utf8');
    fs.mkdirSync(versionRoot, { recursive: true });
    const markerPath = path.join(versionRoot, '.installed.json');
    const marker = {
      protocol: 'cti-speech-component-install/v1',
      id: component.id,
      version: component.version,
      sha256: component.sha256,
      size: component.size,
      source: component.source,
      license: component.license,
      platform: 'win32-x64',
      entryPoint: component.fileName,
      installedAt: '2026-08-07T00:00:00.000Z',
    };
    try {
      const manager = new ManagedSpeechDependencyManager(manifestPath, depsRoot, undefined, 'win32-x64');
      fs.writeFileSync(markerPath, JSON.stringify({ ...marker, protocol: 'forged' }), 'utf8');
      assert.equal(manager.listStatuses()[0]?.state, 'optional_missing');

      fs.writeFileSync(markerPath, JSON.stringify(marker), 'utf8');
      assert.equal(manager.listStatuses()[0]?.state, 'optional_missing', 'marker 不能替代真实入口');

      fs.mkdirSync(path.dirname(entryPoint), { recursive: true });
      fs.writeFileSync(entryPoint, 'runtime', 'utf8');
      assert.equal(manager.listStatuses()[0]?.state, 'optional_missing', '旧 marker 缺少入口哈希时失败关闭');
      fs.writeFileSync(markerPath, JSON.stringify({
        ...marker,
        entryPointSha256: crypto.createHash('sha256').update('runtime').digest('hex'),
        entryPointSize: Buffer.byteLength('runtime'),
      }), 'utf8');
      assert.equal(manager.listStatuses()[0]?.state, 'ready');

      fs.writeFileSync(entryPoint, 'tampered', 'utf8');
      assert.equal(manager.listStatuses()[0]?.state, 'optional_missing', '入口内容变化不能继续冒充已安装');

      fs.rmSync(entryPoint);
      assert.equal(manager.listStatuses()[0]?.state, 'optional_missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when another installer holds the component lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-install-lock-'));
    const manifestPath = path.join(root, 'manifest.json');
    const depsRoot = path.join(root, 'deps');
    fs.writeFileSync(manifestPath, JSON.stringify({
      protocol: 'cti-speech-managed-dependencies/v1',
      components: [{
        id: 'locked_component', displayName: 'Locked', kind: 'binary', capabilities: ['test'],
        source: 'https://example.invalid/runtime.bin', version: 'v1', sha256: 'c'.repeat(64), size: 123,
        license: 'Apache-2.0', archive: 'file', fileName: 'runtime.bin', availability: 'ready',
      }],
    }), 'utf8');
    const componentRoot = path.join(depsRoot, 'speech', 'locked_component');
    fs.mkdirSync(componentRoot, { recursive: true });
    fs.writeFileSync(path.join(componentRoot, '.install.lock'), JSON.stringify({
      protocol: 'cti-speech-component-install-lock/v1',
      componentId: 'locked_component',
      runId: 'external',
      ownerPid: process.pid,
    }), 'utf8');
    try {
      const manager = new ManagedSpeechDependencyManager(manifestPath, depsRoot);
      await assert.rejects(manager.install('locked_component'), /component_install_locked/);
      assert.equal(fs.existsSync(path.join(componentRoot, '.install.lock')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
