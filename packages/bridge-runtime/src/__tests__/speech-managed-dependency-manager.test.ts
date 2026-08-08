import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { assertSafeZipEntryName, ManagedSpeechDependencyManager } from '../speech/managed-dependency-manager.js';

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createPythonInstallerManifest(root: string, overrides: Record<string, unknown> = {}) {
  const pythonArchive = Buffer.from('python-archive');
  const toolArchive = Buffer.from('uv-archive');
  const requirements = 'demo==1.0 --hash=sha256:' + 'a'.repeat(64) + '\n';
  const requirementsDir = path.join(root, 'managed-locks');
  fs.mkdirSync(requirementsDir, { recursive: true });
  fs.writeFileSync(path.join(requirementsDir, 'runtime.lock'), requirements, 'utf8');
  const installer = {
    kind: 'python_target/v1',
    python: {
      source: 'https://example.invalid/python.zip', sha256: sha256(pythonArchive), size: pythonArchive.length,
      archive: 'zip', entryPoint: 'python.exe', pthFile: 'python312._pth', stdlibZip: 'python312.zip',
    },
    tool: {
      source: 'https://example.invalid/uv.zip', sha256: sha256(toolArchive), size: toolArchive.length,
      archive: 'zip', entryPoint: 'uv.exe',
    },
    requirements: { path: 'managed-locks/runtime.lock', sha256: sha256(requirements), size: Buffer.byteLength(requirements) },
    sitePackages: 'Lib/site-packages', pythonVersion: '3.12', probeModules: ['demo'],
    requireCuda: true, cudaVersion: '12.8', requiredDiskBytes: 256 * 1024 * 1024,
  };
  const component = {
    id: 'python_runtime', displayName: 'Python Runtime', kind: 'runtime', capabilities: ['tts_runtime'],
    source: 'https://example.invalid/runtime', version: '1.0.0', sha256: sha256(JSON.stringify(installer)),
    size: pythonArchive.length + toolArchive.length + Buffer.byteLength(requirements), license: 'Apache-2.0',
    archive: 'file', fileName: 'python.exe', availability: 'ready', platforms: [`${process.platform}-${process.arch}`],
    installer,
    ...overrides,
  };
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ protocol: 'cti-speech-managed-dependencies/v2', components: [component] }), 'utf8');
  return { manifestPath, pythonArchive, toolArchive, installer, component };
}

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

  it('exposes only fully pinned speech assets as installable and keeps incomplete runtimes blocked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-manifest-'));
    const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../speech/managed-dependencies.json');
    try {
      const manager = new ManagedSpeechDependencyManager(manifestPath, path.join(root, 'deps'), undefined, 'win32-x64');
      const statuses = new Map(manager.listStatuses().map((item) => [item.id, item]));
      assert.equal(statuses.get('sensevoice_gguf')?.installable, true);
      assert.equal(statuses.get('sensevoice_runtime')?.installable, true);
      assert.equal(statuses.get('qwen3_tts_runtime')?.installable, true);
      assert.equal(statuses.get('ffmpeg_runtime')?.installable, true);
      for (const id of [
        'qwen3-tts-12hz-1.7b-custom-voice',
        'qwen3-tts-12hz-0.6b-custom-voice',
        'qwen3-tts-12hz-1.7b-base',
        'qwen3-tts-12hz-0.6b-base',
      ]) {
        assert.equal(statuses.get(id)?.installable, true, `${id} 必须来自固定 revision 的多文件清单`);
      }
      assert.equal(statuses.get('cosyvoice')?.state, 'blocked');
      assert.equal(statuses.get('cosyvoice_clone')?.diagnosticCode, 'manifest_incomplete');
      assert.equal(statuses.get('ace_step_1_5')?.diagnosticCode, 'manifest_incomplete');
      assert.equal(statuses.get('ace_step_1_5_models')?.installable, true);
      assert.equal(statuses.get('ace_step_1_5_models')?.state, 'optional_missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs a pinned Python target with fixed argv, isolated environment and a successful probe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-python-target-'));
    const depsRoot = path.join(root, 'deps');
    const { manifestPath, pythonArchive, toolArchive } = createPythonInstallerManifest(root);
    const calls: Array<{ executable: string; argv: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    try {
      const manager = new ManagedSpeechDependencyManager(manifestPath, depsRoot, undefined, undefined, undefined, {
        fetchAsset: async ({ targetPath, url }) => fs.writeFileSync(targetPath, url.includes('python') ? pythonArchive : toolArchive),
        extractZip: async (zipPath, destination) => {
          if (zipPath.endsWith('download-python.zip')) {
            fs.writeFileSync(path.join(destination, 'python.exe'), 'python');
            fs.writeFileSync(path.join(destination, 'python312.zip'), 'stdlib');
            fs.writeFileSync(path.join(destination, 'python312._pth'), 'original');
          } else {
            fs.writeFileSync(path.join(destination, 'uv.exe'), 'uv');
          }
        },
        runProcess: async (executable, argv, options) => {
          calls.push({ executable, argv, env: options.env });
          return calls.length === 1
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 0, stdout: '{"version":[3,12],"cuda_available":true,"cuda_version":"12.8"}\n', stderr: '' };
        },
      });
      await manager.install('python_runtime');
      assert.equal(manager.listStatuses()[0]?.state, 'ready');
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0]!.argv.slice(0, 2), ['pip', 'install']);
      assert.equal(calls[0]!.argv.includes('--require-hashes'), true);
      assert.equal(calls[0]!.argv.includes('--no-config'), true);
      assert.equal(calls[0]!.argv.includes('--no-python-downloads'), true);
      assert.equal(calls[1]!.argv[0], '-I');
      assert.match(calls[1]!.argv[2]!, /if True else None/);
      assert.equal(Object.keys(calls[0]!.env || {}).some((key) => /^(PIP_|PYTHONHOME$|PYTHONPATH$)/i.test(key)), false);
      const pth = fs.readFileSync(path.join(depsRoot, 'speech', 'python_runtime', '1.0.0', 'python312._pth'), 'utf8');
      assert.equal(pth, 'python312.zip\n.\nLib/site-packages\nimport site\n');
      assert.equal(fs.readdirSync(path.join(depsRoot, 'speech', 'python_runtime')).some((name) => name.startsWith('.stage-')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects installer identity and bundled lock mismatches before publishing a runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-python-invalid-'));
    try {
      const identity = createPythonInstallerManifest(path.join(root, 'identity'), { sha256: 'f'.repeat(64) });
      assert.throws(() => new ManagedSpeechDependencyManager(identity.manifestPath, path.join(root, 'deps-identity')), /installer_identity_invalid/);

      const lock = createPythonInstallerManifest(path.join(root, 'lock'));
      fs.appendFileSync(path.join(root, 'lock', 'managed-locks', 'runtime.lock'), '# changed\n', 'utf8');
      const manager = new ManagedSpeechDependencyManager(lock.manifestPath, path.join(root, 'deps-lock'), undefined, undefined, undefined, {
        fetchAsset: async ({ targetPath, url }) => fs.writeFileSync(targetPath, url.includes('python') ? lock.pythonArchive : lock.toolArchive),
      });
      await assert.rejects(manager.install('python_runtime'), /requirements_size_mismatch/);
      assert.equal(fs.existsSync(path.join(root, 'deps-lock', 'speech', 'python_runtime', '1.0.0')), false);
      assert.equal(fs.readdirSync(path.join(root, 'deps-lock', 'speech', 'python_runtime')).some((name) => name.startsWith('.stage-')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not publish a Python target when the structured probe fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-python-probe-'));
    const { manifestPath, pythonArchive, toolArchive } = createPythonInstallerManifest(root);
    const depsRoot = path.join(root, 'deps');
    try {
      const manager = new ManagedSpeechDependencyManager(manifestPath, depsRoot, undefined, undefined, undefined, {
        fetchAsset: async ({ targetPath, url }) => fs.writeFileSync(targetPath, url.includes('python') ? pythonArchive : toolArchive),
        extractZip: async (zipPath, destination) => {
          if (zipPath.endsWith('download-python.zip')) {
            for (const [name, value] of [['python.exe', 'python'], ['python312.zip', 'stdlib'], ['python312._pth', 'pth']] as const) {
              fs.writeFileSync(path.join(destination, name), value);
            }
          } else fs.writeFileSync(path.join(destination, 'uv.exe'), 'uv');
        },
        runProcess: async (_executable, argv) => argv[0] === 'pip'
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 0, stdout: '{"version":[3,12],"cuda_available":false,"cuda_version":"12.8"}\n', stderr: '' },
      });
      await assert.rejects(manager.install('python_runtime'), /python_target_cuda_unavailable/);
      assert.equal(fs.existsSync(path.join(depsRoot, 'speech', 'python_runtime', '1.0.0')), false);
      assert.equal(fs.readdirSync(path.join(depsRoot, 'speech', 'python_runtime')).some((name) => name.startsWith('.stage-')), false);
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

  it('accepts a pinned v2 file set and rejects duplicate or escaping targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-file-set-manifest-'));
    const valid = {
      protocol: 'cti-speech-managed-dependencies/v2',
      components: [{
        id: 'model_set', displayName: 'Model Set', kind: 'model', capabilities: ['tts'],
        source: 'https://example.invalid/model', version: 'revision1', license: 'Apache-2.0',
        archive: 'file', fileName: null, sha256: null, size: null, availability: 'ready',
        entryPoint: 'config.json',
        files: [
          { source: 'https://example.invalid/config.json', path: 'config.json', sha256: 'a'.repeat(64), size: 10 },
          { source: 'https://example.invalid/model.bin', path: 'weights/model.bin', sha256: 'b'.repeat(64), size: 20 },
        ],
      }],
    };
    try {
      const validPath = path.join(root, 'valid.json');
      fs.writeFileSync(validPath, JSON.stringify(valid), 'utf8');
      const manager = new ManagedSpeechDependencyManager(validPath, path.join(root, 'deps'));
      assert.equal(manager.listStatuses()[0]?.installable, true);

      for (const [name, files] of [
        ['duplicate', [valid.components[0]!.files[0], { ...valid.components[0]!.files[1], path: 'config.json' }]],
        ['escape', [{ ...valid.components[0]!.files[0], path: '../config.json' }]],
      ] as const) {
        const invalidPath = path.join(root, `${name}.json`);
        fs.writeFileSync(invalidPath, JSON.stringify({ ...valid, components: [{ ...valid.components[0], files }] }), 'utf8');
        assert.throws(() => new ManagedSpeechDependencyManager(invalidPath, path.join(root, `deps-${name}`)), /dependency_manifest_|archive_path_unsafe/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates every file in a v2 install marker and fails after any file changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-file-set-marker-'));
    const manifestPath = path.join(root, 'manifest.json');
    const depsRoot = path.join(root, 'deps');
    const files = [
      { source: 'https://example.invalid/config.json', path: 'config.json', sha256: crypto.createHash('sha256').update('config').digest('hex'), size: 6 },
      { source: 'https://example.invalid/model.bin', path: 'weights/model.bin', sha256: crypto.createHash('sha256').update('weights').digest('hex'), size: 7 },
    ];
    const component = {
      id: 'model_set', displayName: 'Model Set', kind: 'model', capabilities: ['tts'],
      source: 'https://example.invalid/model', version: 'revision1', license: 'Apache-2.0',
      archive: 'file', fileName: null, sha256: null, size: null, availability: 'ready', entryPoint: 'config.json', files,
    };
    const targetRoot = path.join(depsRoot, 'speech', component.id, component.version);
    const manifestSha256 = crypto.createHash('sha256').update(JSON.stringify(files.map((file) => [file.path, file.sha256, file.size, file.source]))).digest('hex');
    try {
      fs.writeFileSync(manifestPath, JSON.stringify({ protocol: 'cti-speech-managed-dependencies/v2', components: [component] }), 'utf8');
      fs.mkdirSync(path.join(targetRoot, 'weights'), { recursive: true });
      fs.writeFileSync(path.join(targetRoot, 'config.json'), 'config', 'utf8');
      fs.writeFileSync(path.join(targetRoot, 'weights', 'model.bin'), 'weights', 'utf8');
      fs.writeFileSync(path.join(targetRoot, '.installed.json'), JSON.stringify({
        protocol: 'cti-speech-component-install/v2', id: component.id, version: component.version,
        source: component.source, license: component.license, platform: `${process.platform}-${process.arch}`,
        entryPoint: component.entryPoint, manifestSha256, totalSize: 13, files,
        installedAt: '2026-08-08T00:00:00.000Z',
      }), 'utf8');
      const manager = new ManagedSpeechDependencyManager(manifestPath, depsRoot);
      assert.equal(manager.listStatuses()[0]?.state, 'ready');
      fs.writeFileSync(path.join(targetRoot, 'weights', 'model.bin'), 'changed', 'utf8');
      assert.equal(manager.listStatuses()[0]?.state, 'optional_missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
