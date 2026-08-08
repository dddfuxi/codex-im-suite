import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { cleanupStaleAtomicWriteTemps, writeUtf8TextAtomic } from '../atomic-text-file.js';
import { assertRegularNonSymlink, ensureNonSymlinkDirectory, isWithinRoot } from './dependency-resolution.js';
import type { ManagedSpeechDependencyManager } from './managed-dependency-manager.js';
import { RuntimeSpeechError, type SpeechRuntimeConfig } from './runtime-types.js';

const STATE_PROTOCOL = 'cti-managed-singing-runtime/v1' as const;
const ACE_RUNTIME_COMPONENT_ID = 'ace_step_1_5';
const ACE_MODEL_COMPONENT_ID = 'ace_step_1_5_models';

// 固定 bootstrap 把官方 API 的可写 project root 与只读模型根彻底分开：
// 缓存/产物进入 Runtime state，模型只从已经通过 marker 的受管模型根读取。
// 官方下载与模型代码同步均被失败关闭，避免离线运行时改写受管权重目录。
const ACE_SERVER_BOOTSTRAP = [
  'import os',
  'from acestep.gpu_config import get_gpu_config',
  '_gpu_config=get_gpu_config()',
  // 官方 API 的 offload_to_cpu 会按显存自动开启，但 offload_dit_to_cpu 的
  // 环境默认值仍是 false；显式复用官方 GPU 档位，避免低显存设备在 VAE
  // 解码时继续让 DiT 常驻显存，同时不拖慢高显存设备。
  'os.environ["ACESTEP_OFFLOAD_TO_CPU"]="true" if _gpu_config.offload_to_cpu_default else "false"',
  'os.environ["ACESTEP_OFFLOAD_DIT_TO_CPU"]="true" if _gpu_config.offload_dit_to_cpu_default else "false"',
  'import acestep.api_server as server',
  'import acestep.api.startup_model_init as startup_model_init',
  'state_root=os.environ["CTI_ACESTEP_STATE_ROOT"]',
  'model_root=os.path.realpath(os.environ["CTI_ACESTEP_MODEL_ROOT"])',
  'server._get_project_root=lambda: state_root',
  'def _managed_model(model_name, _checkpoint_dir):',
  '    if not isinstance(model_name, str) or not model_name or model_name in (".", "..") or os.path.basename(model_name) != model_name:',
  '        raise RuntimeError("managed_model_name_invalid")',
  '    candidate=os.path.realpath(os.path.join(model_root, model_name))',
  '    if os.path.commonpath((model_root, candidate)) != model_root or os.path.islink(candidate) or not os.path.isdir(candidate):',
  '        raise RuntimeError("managed_model_missing_or_unsafe")',
  '    return candidate',
  'server._ensure_model_downloaded=_managed_model',
  '_original_llm_init=startup_model_init.initialize_llm_at_startup',
  'def _managed_llm_init(**kwargs):',
  '    kwargs["checkpoint_dir"]=model_root',
  '    kwargs["ensure_model_downloaded"]=_managed_model',
  '    return _original_llm_init(**kwargs)',
  'startup_model_init.initialize_llm_at_startup=_managed_llm_init',
  '_original_init=server.initialize_models_at_startup',
  'def _managed_init(**kwargs):',
  '    kwargs["get_project_root"]=lambda: state_root',
  '    kwargs["ensure_model_downloaded"]=_managed_model',
  '    for handler in (kwargs.get("handler"), kwargs.get("handler2"), kwargs.get("handler3")):',
  '        if handler is not None:',
  '            handler._ensure_models_present=lambda **inner_kwargs: None',
  '            handler._sync_model_code_if_needed=lambda *args, **inner_kwargs: None',
  '    return _original_init(**kwargs)',
  'server.initialize_models_at_startup=_managed_init',
  'server.run_api_server_main(env_bool=server._env_bool)',
].join('\n');

interface ManagedSingingRuntimeState {
  protocol: typeof STATE_PROTOCOL;
  runId: string;
  ownerPid: number;
  childPid: number;
  port: number;
  startedAt: string;
  runtimeVersion: string;
  modelVersion: string;
}
export interface ManagedSingingRuntimeEndpoint {
  baseUrl: string;
  token: string;
}

interface SupervisorOperations {
  allocatePort(): Promise<number>;
  spawnProcess: typeof spawn;
  fetchImpl: typeof fetch;
  processAlive(pid: number): boolean;
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error || port <= 0 ? reject(error || new Error('singing_port_invalid')) : resolve(port));
    });
  });
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const defaultOperations: SupervisorOperations = {
  allocatePort: allocateLoopbackPort,
  spawnProcess: spawn,
  fetchImpl: fetch,
  processAlive,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new RuntimeSpeechError('singing_runtime_start_cancelled', 'error', '歌声 Runtime 启动已取消'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function parseState(filePath: string): ManagedSingingRuntimeState | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024) return undefined;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ManagedSingingRuntimeState>;
    if (value.protocol !== STATE_PROTOCOL || typeof value.runId !== 'string'
      || !Number.isSafeInteger(value.ownerPid) || !Number.isSafeInteger(value.childPid)
      || !Number.isSafeInteger(value.port) || typeof value.startedAt !== 'string'
      || typeof value.runtimeVersion !== 'string' || typeof value.modelVersion !== 'string') return undefined;
    return value as ManagedSingingRuntimeState;
  } catch { return undefined; }
}

function createIsolatedEnvironment(input: {
  stateRoot: string;
  modelRoot: string;
  modelId: string;
  lmModelId: string;
  token: string;
  ffmpegDirectory?: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('ACESTEP_') || upper.startsWith('CTI_ACESTEP_')
      || upper === 'PYTHONHOME' || upper === 'PYTHONPATH'
      || upper === 'HF_TOKEN' || upper === 'HUGGING_FACE_HUB_TOKEN'
      || upper === 'HTTP_PROXY' || upper === 'HTTPS_PROXY' || upper === 'ALL_PROXY') continue;
    environment[key] = value;
  }
  const tempRoot = path.join(input.stateRoot, 'temp');
  const cacheRoot = path.join(input.stateRoot, 'cache');
  for (const directory of [tempRoot, cacheRoot]) ensureNonSymlinkDirectory(directory);
  environment.PYTHONUTF8 = '1';
  environment.PYTHONIOENCODING = 'utf-8';
  environment.PYTHONNOUSERSITE = '1';
  environment.CTI_ACESTEP_STATE_ROOT = input.stateRoot;
  environment.CTI_ACESTEP_MODEL_ROOT = input.modelRoot;
  environment.ACESTEP_CHECKPOINTS_DIR = input.modelRoot;
  environment.ACESTEP_API_KEY = input.token;
  environment.ACESTEP_CONFIG_PATH = input.modelId;
  environment.ACESTEP_LM_MODEL_PATH = input.lmModelId;
  environment.ACESTEP_LM_BACKEND = 'pt';
  // 当前受限歌声请求使用官方直接 DiT 路径；不在启动阶段常驻加载 LM。
  environment.ACESTEP_INIT_LLM = 'false';
  environment.ACESTEP_NO_INIT = 'false';
  environment.ACESTEP_QUEUE_WORKERS = '1';
  environment.ACESTEP_API_WORKERS = '1';
  environment.ACESTEP_TMPDIR = tempRoot;
  environment.HF_HOME = path.join(cacheRoot, 'huggingface');
  environment.TRANSFORMERS_CACHE = path.join(cacheRoot, 'transformers');
  environment.TRITON_CACHE_DIR = path.join(cacheRoot, 'triton');
  environment.TORCHINDUCTOR_CACHE_DIR = path.join(cacheRoot, 'torchinductor');
  environment.HF_HUB_OFFLINE = '1';
  environment.TRANSFORMERS_OFFLINE = '1';
  environment.HF_DATASETS_OFFLINE = '1';
  environment.TEMP = tempRoot;
  environment.TMP = tempRoot;
  environment.TMPDIR = tempRoot;
  if (input.ffmpegDirectory) environment.PATH = `${input.ffmpegDirectory}${path.delimiter}${environment.PATH || ''}`;
  return environment;
}

export class ManagedSingingRuntimeSupervisor {
  private readonly stateRoot: string;
  private readonly statePath: string;
  private readonly stdoutPath: string;
  private readonly stderrPath: string;
  private readonly operations: SupervisorOperations;
  private child?: ChildProcess;
  private endpoint?: ManagedSingingRuntimeEndpoint;
  private runId?: string;
  private startPromise?: Promise<ManagedSingingRuntimeEndpoint>;

  constructor(private readonly options: {
    config: SpeechRuntimeConfig;
    ctiHome: string;
    dependencies: ManagedSpeechDependencyManager;
    operations?: Partial<SupervisorOperations>;
  }) {
    this.stateRoot = path.resolve(options.ctiHome, 'runtime', 'speech', 'ace-step-host');
    ensureNonSymlinkDirectory(this.stateRoot);
    this.statePath = path.join(this.stateRoot, 'runtime.json');
    this.stdoutPath = path.join(this.stateRoot, 'stdout.log');
    this.stderrPath = path.join(this.stateRoot, 'stderr.log');
    cleanupStaleAtomicWriteTemps(this.statePath);
    this.operations = { ...defaultOperations, ...options.operations };
  }

  isRunning(): boolean {
    return Boolean(this.endpoint && this.child?.pid && this.operations.processAlive(this.child.pid));
  }

  async ensureRunning(signal?: AbortSignal): Promise<ManagedSingingRuntimeEndpoint> {
    if (this.isRunning()) return this.endpoint!;
    if (!this.startPromise) this.startPromise = this.startManaged(signal).finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async startManaged(signal?: AbortSignal): Promise<ManagedSingingRuntimeEndpoint> {
    const runtime = this.options.dependencies.resolveInstalledComponent(ACE_RUNTIME_COMPONENT_ID);
    const models = this.options.dependencies.resolveInstalledComponent(ACE_MODEL_COMPONENT_ID);
    if (!runtime || !models) {
      throw new RuntimeSpeechError('singing_managed_components_missing', 'optional_missing', 'ACE-Step Runtime 或模型尚未安装');
    }
    assertRegularNonSymlink(runtime.entryPoint);
    if (!isWithinRoot(runtime.entryPoint, runtime.root) || !isWithinRoot(models.entryPoint, models.root)) {
      throw new RuntimeSpeechError('singing_managed_component_unsafe', 'blocked', 'ACE-Step 受管组件边界无效');
    }

    const previous = parseState(this.statePath);
    if (previous && (this.operations.processAlive(previous.ownerPid) || this.operations.processAlive(previous.childPid))) {
      throw new RuntimeSpeechError('singing_runtime_already_running', 'blocked', '已有歌声 Runtime 进程占用受管状态');
    }
    if (previous) {
      try { fs.unlinkSync(this.statePath); } catch { throw new RuntimeSpeechError('singing_runtime_state_locked', 'blocked', '旧歌声 Runtime 状态无法清理'); }
    }

    const ffmpeg = this.options.dependencies.resolveInstalledComponent('ffmpeg_runtime');
    const port = await this.operations.allocatePort();
    const token = crypto.randomBytes(32).toString('base64url');
    const runId = crypto.randomUUID();
    const environment = createIsolatedEnvironment({
      stateRoot: this.stateRoot,
      modelRoot: models.root,
      modelId: this.options.config.singingModel,
      lmModelId: this.options.config.singingLmModel,
      token,
      ...(ffmpeg ? { ffmpegDirectory: path.dirname(ffmpeg.entryPoint) } : {}),
    });
    const stdout = fs.openSync(this.stdoutPath, 'a', 0o600);
    const stderr = fs.openSync(this.stderrPath, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = this.operations.spawnProcess(runtime.entryPoint, [
        '-I', '-c', ACE_SERVER_BOOTSTRAP,
        // ACE-Step 官方入口直接读取 ACESTEP_API_KEY；令牌只进入子进程环境，
        // 禁止出现在 Windows CommandLine、诊断进程列表或状态文件中。
        '--host', '127.0.0.1', '--port', String(port),
      ], {
        cwd: this.stateRoot,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', stdout, stderr],
      });
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
    if (!child.pid) throw new RuntimeSpeechError('singing_runtime_spawn_failed', 'error', '歌声 Runtime 进程未启动');
    this.child = child;
    this.runId = runId;
    const state: ManagedSingingRuntimeState = {
      protocol: STATE_PROTOCOL,
      runId,
      ownerPid: process.pid,
      childPid: child.pid,
      port,
      startedAt: new Date().toISOString(),
      runtimeVersion: runtime.version,
      modelVersion: models.version,
    };
    writeUtf8TextAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    child.once('exit', () => this.handleExit(runId));
    child.once('error', () => this.handleExit(runId));

    const endpoint = { baseUrl: `http://127.0.0.1:${port}/`, token };
    const deadline = Date.now() + Math.min(this.options.config.singingTimeoutMs, 10 * 60_000);
    while (Date.now() < deadline) {
      if (!this.operations.processAlive(child.pid)) break;
      try {
        const response = await this.operations.fetchImpl(new URL('health', endpoint.baseUrl), {
          headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal,
        });
        if (response.ok) {
          this.endpoint = endpoint;
          return endpoint;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      await sleep(500, signal);
    }
    this.stop();
    throw new RuntimeSpeechError('singing_runtime_start_failed', 'error', '歌声 Runtime 未在限定时间内通过健康检查');
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    if (child?.pid && this.operations.processAlive(child.pid)) {
      try { child.kill('SIGTERM'); } catch { /* 退出链继续按状态归属清理。 */ }
    }
    this.removeOwnedState(this.runId);
    this.runId = undefined;
  }

  private handleExit(runId: string): void {
    if (this.runId !== runId) return;
    this.child = undefined;
    this.endpoint = undefined;
    this.removeOwnedState(runId);
    this.runId = undefined;
  }

  private removeOwnedState(runId: string | undefined): void {
    if (!runId) return;
    const state = parseState(this.statePath);
    if (state?.runId !== runId || state.ownerPid !== process.pid) return;
    try {
      const resolved = path.resolve(this.statePath);
      if (isWithinRoot(resolved, this.stateRoot)) fs.unlinkSync(resolved);
    } catch { /* 观察链清理失败不覆盖真实进程终态。 */ }
  }
}
