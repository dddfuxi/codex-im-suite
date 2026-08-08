import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManagedSingingRuntimeSupervisor } from '../speech/managed-singing-runtime-supervisor.js';
import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import type { ManagedSpeechDependencyManager } from '../speech/managed-dependency-manager.js';

function fixture(input: { installed?: boolean; alivePids?: number[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-singing-supervisor-'));
  const runtimeRoot = path.join(root, 'runtime-component');
  const modelRoot = path.join(root, 'model-component');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(modelRoot, 'acestep-v15-turbo'), { recursive: true });
  const python = path.join(runtimeRoot, 'python.exe');
  const modelEntry = path.join(modelRoot, 'acestep-v15-turbo', 'config.json');
  fs.writeFileSync(python, 'fixture', 'utf8');
  fs.writeFileSync(modelEntry, '{}', 'utf8');
  const installed = input.installed !== false;
  const dependencies = {
    resolveInstalledComponent(id: string) {
      if (!installed) return undefined;
      if (id === 'ace_step_1_5') return { id, version: 'runtime-v1', root: runtimeRoot, entryPoint: python };
      if (id === 'ace_step_1_5_models') return { id, version: 'models-v1', root: modelRoot, entryPoint: modelEntry };
      return undefined;
    },
  } as unknown as ManagedSpeechDependencyManager;
  const config = loadSpeechRuntimeConfig(new Map([
    ['CTI_SINGING_ENABLED', 'true'],
    ['CTI_SINGING_TIMEOUT_MS', '10000'],
  ]));
  const alive = new Set(input.alivePids || []);
  return { root, config, dependencies, alive, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('managed singing runtime supervisor', () => {
  it('缺少受管组件时失败关闭且不启动进程', async () => {
    const value = fixture({ installed: false });
    try {
      let spawned = false;
      const supervisor = new ManagedSingingRuntimeSupervisor({
        config: value.config,
        ctiHome: value.root,
        dependencies: value.dependencies,
        operations: {
          spawnProcess: (() => { spawned = true; throw new Error('unexpected'); }) as never,
        },
      });
      await assert.rejects(supervisor.ensureRunning(), (error: unknown) => (
        Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'singing_managed_components_missing')
      ));
      assert.equal(spawned, false);
    } finally { value.cleanup(); }
  });

  it('只绑定 loopback、离线启动且临时令牌不写入状态文件', async () => {
    const value = fixture();
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean };
    child.pid = 43210;
    child.kill = () => { value.alive.delete(child.pid); return true; };
    value.alive.add(child.pid);
    try {
      const supervisor = new ManagedSingingRuntimeSupervisor({
        config: value.config,
        ctiHome: value.root,
        dependencies: value.dependencies,
        operations: {
          allocatePort: async () => 43123,
          processAlive: (pid) => value.alive.has(pid),
          spawnProcess: ((command: string, args: string[], options: Record<string, unknown>) => {
            calls.push({ command, args, options });
            return child;
          }) as never,
          fetchImpl: (async (request: string | URL | Request) => {
            assert.equal(String(request), 'http://127.0.0.1:43123/health');
            return new Response('{}', { status: 200 });
          }) as typeof fetch,
        },
      });
      const endpoint = await supervisor.ensureRunning();
      assert.equal(endpoint.baseUrl, 'http://127.0.0.1:43123/');
      assert.ok(endpoint.token.length >= 32);
      assert.equal(calls.length, 1);
      const hostIndex = calls[0].args.indexOf('--host');
      assert.deepEqual(calls[0].args.slice(hostIndex, hostIndex + 4), ['--host', '127.0.0.1', '--port', '43123']);
      assert.equal(calls[0].args.includes('--api-key'), false);
      assert.equal(calls[0].args.includes(endpoint.token), false);
      const environment = calls[0].options.env as NodeJS.ProcessEnv;
      assert.equal(environment.ACESTEP_API_KEY, endpoint.token);
      assert.equal(environment.ACESTEP_CHECKPOINTS_DIR, path.join(value.root, 'model-component'));
      assert.equal(environment.HF_HUB_OFFLINE, '1');
      assert.equal(environment.TRANSFORMERS_OFFLINE, '1');
      assert.equal(environment.ACESTEP_QUEUE_WORKERS, '1');
      assert.equal(environment.ACESTEP_INIT_LLM, 'false');
      assert.equal(environment.PYTHONNOUSERSITE, '1');
      assert.equal(calls[0].args.includes('--init-llm'), false);
      assert.equal(calls[0].args.includes('--lm-model-path'), false);
      const bootstrap = calls[0].args[calls[0].args.indexOf('-c') + 1];
      assert.match(bootstrap, /_gpu_config=get_gpu_config\(\)/u);
      assert.match(bootstrap, /ACESTEP_OFFLOAD_TO_CPU/u);
      assert.match(bootstrap, /ACESTEP_OFFLOAD_DIT_TO_CPU/u);
      assert.match(bootstrap, /server\._ensure_model_downloaded=_managed_model/u);
      assert.match(bootstrap, /kwargs\["checkpoint_dir"\]=model_root/u);
      assert.match(bootstrap, /kwargs\["get_project_root"\]=lambda: state_root/u);
      assert.match(bootstrap, /handler\._ensure_models_present=lambda/u);
      assert.match(bootstrap, /handler\._sync_model_code_if_needed=lambda/u);
      assert.doesNotMatch(bootstrap, /lambda: model_root/u);
      const statePath = path.join(value.root, 'runtime', 'speech', 'ace-step-host', 'runtime.json');
      const stateText = fs.readFileSync(statePath, 'utf8');
      assert.equal(stateText.includes(endpoint.token), false);
      assert.equal(stateText.includes('127.0.0.1'), false);
      supervisor.stop();
      assert.equal(fs.existsSync(statePath), false);
    } finally { value.cleanup(); }
  });

  it('发现旧活进程时不接管也不覆盖状态', async () => {
    const value = fixture({ alivePids: [9991] });
    try {
      const stateRoot = path.join(value.root, 'runtime', 'speech', 'ace-step-host');
      fs.mkdirSync(stateRoot, { recursive: true });
      const statePath = path.join(stateRoot, 'runtime.json');
      fs.writeFileSync(statePath, JSON.stringify({
        protocol: 'cti-managed-singing-runtime/v1', runId: 'previous', ownerPid: 9991,
        childPid: 9992, port: 40000, startedAt: new Date().toISOString(), runtimeVersion: 'v1', modelVersion: 'v1',
      }), 'utf8');
      const supervisor = new ManagedSingingRuntimeSupervisor({
        config: value.config,
        ctiHome: value.root,
        dependencies: value.dependencies,
        operations: { processAlive: (pid) => value.alive.has(pid) },
      });
      await assert.rejects(supervisor.ensureRunning(), (error: unknown) => (
        Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'singing_runtime_already_running')
      ));
      assert.equal(fs.existsSync(statePath), true);
    } finally { value.cleanup(); }
  });
});
