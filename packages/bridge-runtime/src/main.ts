/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';
import './adapters/weixin-adapter.js';

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { LocalLlamaProvider } from './local-llm-provider.js';
import { decideLocalRoute } from './local-llm-router.js';
import { readLocalLlmStatus, updateLocalLlmStatus } from './local-llm-status.js';
import { sseEvent } from './sse-utils.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(MODULE_DIR, '..');
const CORE_ROOT = path.resolve(SKILL_ROOT, '..', 'claude-to-im-core');

class RoutedLlmProvider implements LLMProvider {
  constructor(
    private readonly config: Config,
    private readonly localProvider: LocalLlamaProvider,
    private readonly fallbackProvider: LLMProvider,
  ) {}

  streamChat(params: Parameters<LLMProvider['streamChat']>[0]): ReturnType<LLMProvider['streamChat']> {
    const decision = decideLocalRoute(params, this.config);
    if (!decision.useLocal) {
      const current = readLocalLlmStatus(this.config);
      updateLocalLlmStatus(this.config, {
        routeMisses: current.routeMisses + 1,
        lastProvider: 'codex',
        lastRequestKind: decision.requestKind,
        lastRouteReason: decision.reason,
      });
      return this.fallbackProvider.streamChat(params);
    }

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          const current = readLocalLlmStatus(this.config);
          updateLocalLlmStatus(this.config, {
            routeHits: current.routeHits + 1,
            lastProvider: 'local',
            lastRequestKind: decision.requestKind,
            lastRouteReason: decision.reason,
            serverReachable: true,
            lastCheckAt: new Date().toISOString(),
            lastError: '',
          });
          const result = await this.localProvider.run(params);
          controller.enqueue(sseEvent('status', { provider: 'local-llama', routeReason: decision.reason }));
          controller.enqueue(sseEvent('text', result.text));
          controller.enqueue(sseEvent('result', {
            subtype: 'success',
            is_error: false,
            session_id: params.sessionId,
            usage: result.usage || {},
          }));
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = readLocalLlmStatus(this.config);
          updateLocalLlmStatus(this.config, {
            fallbackCount: current.fallbackCount + 1,
            lastProvider: 'codex',
            lastRequestKind: decision.requestKind,
            lastRouteReason: decision.reason,
            lastFallbackReason: message,
            lastError: message,
            serverReachable: false,
            lastCheckAt: new Date().toISOString(),
          });
          controller.enqueue(sseEvent('status', { provider: 'codex', fallbackFrom: 'local-llama', reason: message }));
          const stream = this.fallbackProvider.streamChat(params);
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        }
      },
    });
  }
}

function collectTsFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function computeFingerprint(paths: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const filePath of paths.filter((value, index, array) => value && array.indexOf(value) === index).sort()) {
    if (!fs.existsSync(filePath)) continue;
    hash.update(filePath);
    hash.update('\n');
    hash.update(fs.readFileSync(filePath));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}

function computeRuntimeFingerprints(): { bridgeFingerprint: string; toolingFingerprint: string } {
  const bridgeFiles = [
    ...collectTsFiles(path.join(CORE_ROOT, 'src', 'lib', 'bridge')),
    path.join(SKILL_ROOT, 'src', 'store.ts'),
    path.join(SKILL_ROOT, 'src', 'config.ts'),
  ];
  const toolingFiles = [
    path.join(SKILL_ROOT, 'src', 'codex-provider.ts'),
    path.join(SKILL_ROOT, 'src', 'llm-provider.ts'),
    path.join(SKILL_ROOT, 'src', 'main.ts'),
  ];
  return {
    bridgeFingerprint: computeFingerprint(bridgeFiles),
    toolingFingerprint: computeFingerprint(toolingFiles),
  };
}

/**
 * Resolve the LLM provider based on the runtime setting.
 * - 'claude' (default): uses Claude Code SDK via SDKLLMProvider
 * - 'codex': uses @openai/codex-sdk via CodexProvider
 * - 'auto': tries Claude first, falls back to Codex
 */
async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const wrapWithLocalRoute = (provider: LLMProvider): LLMProvider => {
    if (config.localLlmEnabled !== true) return provider;
    return new RoutedLlmProvider(config, new LocalLlamaProvider(config), provider);
  };

  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return wrapWithLocalRoute(new CodexProvider(pendingPerms));
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      // Auto mode: preflight the resolved CLI before committing to it.
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
      }
      // Preflight failed — fall through to Codex instead of silently using a broken CLI
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
        `  Falling back to Codex.`,
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }
    const { CodexProvider } = await import('./codex-provider.js');
    return wrapWithLocalRoute(new CodexProvider(pendingPerms));
  }

  // Default: claude
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      '[claude-to-im] FATAL: Cannot find the `claude` CLI executable.\n' +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n' +
      '  Fix: Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n' +
      '  Or: Set CTI_RUNTIME=codex to use Codex instead',
    );
    process.exit(1);
  }

  // Preflight: verify the CLI can actually run in the daemon environment.
  // In claude runtime this is fatal — starting with a broken CLI would just
  // defer the error to the first user message, which is harder to diagnose.
  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[claude-to-im] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}\n` +
      `  Fix:\n` +
      `    1. Install Claude Code CLI >= 2.x: https://docs.anthropic.com/en/docs/claude-code\n` +
      `    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n` +
      `    3. Or set CTI_RUNTIME=auto to fall back to Codex`,
    );
    process.exit(1);
  }

  return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();
  updateLocalLlmStatus(config, {});

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  if (!settings.get('bridge_unity_mcp_endpoint_list')) {
    settings.set('bridge_unity_mcp_endpoint_list', 'http://127.0.0.1:8081/mcp;http://127.0.0.1:8080/mcp;http://127.0.0.1:8080');
  }
  if (!settings.get('bridge_unity_mcp_start_command')) {
    const unityLauncher = path.join(SKILL_ROOT, 'scripts', 'launch-unity-mcp.ps1').replace(/'/g, "''");
    settings.set('bridge_unity_mcp_start_command', `& '${unityLauncher}'`);
  }
  const { bridgeFingerprint, toolingFingerprint } = computeRuntimeFingerprints();
  settings.set('bridge_runtime_fingerprint', bridgeFingerprint);
  settings.set('bridge_tooling_fingerprint', toolingFingerprint);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[claude-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[claude-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[claude-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[claude-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[claude-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
