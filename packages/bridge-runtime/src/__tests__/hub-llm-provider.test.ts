import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from '../config.js';
import { MavisExecutorProvider } from '../mavis-executor-provider.js';
import { ExecutorProviderRegistry } from '../executor-provider-registry.js';
import type {
  ExecutorRequest,
} from '../executor-types.js';
import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import type {
  MavisClient,
  MavisSessionInfo,
  MavisMessage,
  MavisDiff,
  MavisModelDescriptor,
} from '../mavis-cli-client.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  allowedWorkspaceRoots: [process.cwd()],
  mavisEnabled: true,
  mavisCliPath: 'mavis',
  mavisPollIntervalMs: 50,
  mavisHardTimeoutMs: 5_000,
  mavisQuietTimeoutMs: 1_000,
  mavisMaxDiffBytes: 1024,
};

const model: MavisModelDescriptor = { provider_id: 'mavis', model_id: 'sonnet' };

class ScriptedMavisClient implements MavisClient {
  private infoQueue: MavisSessionInfo[];
  private messagesQueue: MavisMessage[][];
  private diffsQueue: MavisDiff[][];

  constructor(script: {
    info?: MavisSessionInfo[];
    messages?: MavisMessage[][];
    diffs?: MavisDiff[][];
  }) {
    // Copy the input arrays so we own the queue (avoids any accidental sharing).
    this.infoQueue = (script.info || []).slice();
    this.messagesQueue = (script.messages || []).slice();
    this.diffsQueue = (script.diffs || []).slice();
  }

  async status() { return { status: 'running' as const }; }
  async listAgents() { return []; }
  async listSessions() { return { sessions: [] }; }
  async createSession() {
    return {
      session: {
        sessionId: 'mvs_new',
        agentName: 'mavis',
        agentRole: 'agent',
        displayName: 'mavis',
        title: 'mavis:test',
        status: 'idle' as const,
        model,
      },
    };
  }
  async info(_sid: string): Promise<MavisSessionInfo> {
    if (this.infoQueue.length > 0) return this.infoQueue.shift()!;
    return {
      session: {
        sessionId: _sid,
        agentName: 'mavis',
        agentRole: 'agent',
        displayName: 'mavis',
        title: 'mavis:test',
        status: 'finished' as const,
        model,
      },
    };
  }
  async messages(_sid: string): Promise<{ messages: MavisMessage[] }> {
    if (this.messagesQueue.length > 0) return { messages: this.messagesQueue.shift()! };
    return { messages: [] };
  }
  async diff(_sid: string): Promise<{ diffs: MavisDiff[] }> {
    if (this.diffsQueue.length > 0) return { diffs: this.diffsQueue.shift()! };
    return { diffs: [] };
  }
  async communicationPeers() { return { sessions: [], count: 0 }; }
  async communicationMessages() { return { messages: [], count: 0 }; }
  async communicationSend() { return { ok: true }; }
}

function collectSse(stream: ReadableStream<string>): Promise<string[]> {
  const parts: string[] = [];
  const reader = stream.getReader();
  return (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    return parts;
  })();
}

let sessionCounter = 0;
function params(overrides: Partial<StreamChatParams> = {}): StreamChatParams {
  sessionCounter += 1;
  return {
    sessionId: overrides.sessionId || `bridge-hlp-${sessionCounter}`,
    prompt: 'check git status',
    workingDirectory: process.cwd(),
    permissionMode: 'default',
    ...overrides,
  };
}

let hlpTmpHome = '';
let prevCtiHomeHlp: string | undefined;

describe('hub-llm-provider dispatch contract', () => {
  before(() => {
    hlpTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-hlp-suite-'));
    prevCtiHomeHlp = process.env.CTI_HOME;
    process.env.CTI_HOME = hlpTmpHome;
  });
  after(() => {
    if (hlpTmpHome && fs.existsSync(hlpTmpHome)) {
      fs.rmSync(hlpTmpHome, { recursive: true, force: true });
    }
    if (prevCtiHomeHlp === undefined) delete process.env.CTI_HOME;
    else process.env.CTI_HOME = prevCtiHomeHlp;
  });

  it('skips an unhealthy local light-chat provider after the first transport failure', async () => {
    const { HubLlmProvider } = await import('../main.js');
    const { JsonFileStore } = await import('../store.js');
    const { readLocalLlmStatus } = await import('../local-llm-status.js');
    const config: Config = {
      ...baseConfig,
      ollamaEnabled: true,
      localLlmEnabled: true,
      localLlmRouterEnabled: true,
      localLlmForceHub: true,
      localLlmRouterMode: 'hybrid',
      lightChatFastPathEnabled: true,
      localAiBaseUrl: 'http://127.0.0.1:11434',
      localAiModel: 'test-model',
    };
    let localCalls = 0;
    let fallbackCalls = 0;
    const localProvider = {
      complete: async () => {
        localCalls += 1;
        throw new Error('fetch failed');
      },
    };
    const fallbackProvider = {
      streamChat: () => {
        fallbackCalls += 1;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Codex 回复' })}\n\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: '{}' })}\n\n`);
            controller.close();
          },
        });
      },
    };
    const hub = new HubLlmProvider(
      config,
      new JsonFileStore(new Map()),
      localProvider as never,
      {} as never,
      fallbackProvider as never,
      null,
      'codex',
      fallbackProvider as never,
    );
    const lightParams = {
      ...params({ prompt: '在呢', permissionMode: 'acceptEdits' }),
      systemPrompt: [
        'Channel assistant identity:',
        'Feishu emoji presentation:',
        'Feishu sticker library:',
      ].join('\n'),
    };

    await collectSse(hub.streamChat(lightParams));
    await collectSse(hub.streamChat({ ...lightParams, sessionId: `${lightParams.sessionId}-2` }));

    assert.equal(localCalls, 1, 'open circuit must skip repeated local attempts');
    assert.equal(fallbackCalls, 2);
    assert.equal(readLocalLlmStatus(config).serverReachable, false, 'Codex fallback must not overwrite local health');
  });

  it('does not retry the same local target inside the Codex failover chain', async () => {
    const { HubLlmProvider, CodexApiFailoverProvider } = await import('../main.js');
    const { JsonFileStore } = await import('../store.js');
    const config: Config = {
      ...baseConfig,
      ollamaEnabled: true,
      localLlmEnabled: true,
      localLlmRouterEnabled: true,
      localLlmForceHub: true,
      localLlmRouterMode: 'hybrid',
      lightChatFastPathEnabled: true,
      localAiBaseUrl: 'http://127.0.0.1:11434',
      localAiModel: 'test-model',
    };
    let failoverLocalCalls = 0;
    let officialCalls = 0;
    const localFastPath = { complete: async () => { throw new Error('fetch failed'); } };
    const localFailoverProvider: LLMProvider = {
      streamChat: () => {
        failoverLocalCalls += 1;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: 'fetch failed' })}\n\n`);
            controller.close();
          },
        });
      },
    };
    const officialProvider: LLMProvider = {
      streamChat: () => {
        officialCalls += 1;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'official-ok' })}\n\n`);
            controller.close();
          },
        });
      },
    };
    const fallback = new CodexApiFailoverProvider([
      { source: 'local_api', provider: localFailoverProvider },
      { source: 'official', provider: officialProvider },
    ], { candidateTimeoutMs: 100 });
    const hub = new HubLlmProvider(
      config,
      new JsonFileStore(new Map()),
      localFastPath as never,
      {} as never,
      fallback,
      null,
      'codex',
      fallback,
    );

    await collectSse(hub.streamChat({
      ...params({ prompt: '在呢', permissionMode: 'acceptEdits' }),
      systemPrompt: 'Channel assistant identity:\nFeishu emoji presentation:\nFeishu sticker library:',
    }));

    assert.equal(failoverLocalCalls, 0, 'a failed local target must not be retried in the same turn');
    assert.equal(officialCalls, 1);
  });

  it('registry routes @mavis hint to MavisExecutorProvider (not the default Codex chain)', async () => {
    const registry = new ExecutorProviderRegistry();
    const mavisClient = new ScriptedMavisClient({});
    const mavis = new MavisExecutorProvider({
      client: mavisClient,
      config: baseConfig,
      agentName: 'mavis',
      pollIntervalMs: 50,
      hardTimeoutMs: 5_000,
      quietTimeoutMs: 1_000,
      maxDiffBytes: 1024,
    });
    registry.register('mavis-agent', mavis);

    const fakeCodex = {
      streamChat: () => new ReadableStream<string>({ start(c) { c.enqueue('event: text\ndata: "codex was called!"\n\n'); c.close(); } }),
    };

    const dispatch = registry.resolveForRequest(
      baseConfig,
      {
        sessionId: 'bridge-1',
        prompt: '@mavis summarize logs',
        workingDirectory: process.cwd(),
        permissionMode: 'default',
        params: params({ prompt: '@mavis summarize logs' }),
      },
      fakeCodex as never,
    );

    assert.equal(dispatch.isExternal, true);
    assert.equal(dispatch.selection.executor.id, 'mavis-agent');
    // sanity: the default Codex provider is NOT in the dispatch path
    assert.notEqual(dispatch.provider, fakeCodex);
  });

  it('preDispatch failure: MavisExecutorProvider throws → HubLlmProvider would fall back to local chain', async () => {
    // Simulate a pre-dispatch failure: client.createSession throws.
    // The contract is: caller catches this in `streamExternalDispatch` and
    // routes to the local chain (we verify the provider throws a
    // MavisSafetyError with a recoverable code).
    const client = new ScriptedMavisClient({});
    const provider = new MavisExecutorProvider({
      client,
      config: { ...baseConfig, defaultWorkDir: '/some/invalid/path' }, // invalid → workspace gate fails
      agentName: 'mavis',
      pollIntervalMs: 50,
      hardTimeoutMs: 5_000,
      quietTimeoutMs: 1_000,
      maxDiffBytes: 1024,
    });
    await assert.rejects(
      () => provider.preDispatch(params({ workingDirectory: '/some/invalid/path' })),
      /workspace|denied/i,
    );
  });

  it('post-dispatch: status=finished → emits text SSE; no fallback', async () => {
    const client = new ScriptedMavisClient({
      info: [
        { session: { sessionId: 'mvs_1', agentName: 'mavis', agentRole: 'agent', displayName: 'mavis', title: 'mavis:t', status: 'finished', lastActiveAt: new Date().toISOString(), model } },
      ],
      messages: [
        [
          { msg_id: 'm1', role: 'assistant', msg_type: 1, msg_content: 'pong', timestamp: 1 },
        ],
      ],
      diffs: [[]],
    });
    const provider = new MavisExecutorProvider({
      client,
      config: baseConfig,
      agentName: 'mavis',
      pollIntervalMs: 10,
      hardTimeoutMs: 1_000,
      quietTimeoutMs: 500,
      maxDiffBytes: 1024,
    });
    await provider.preDispatch(params());
    assert.ok(provider.binding);
    const stream = new ReadableStream<string>({
      start: async (controller) => {
        await provider.streamUntilFinish(params(), provider.binding!, controller);
        controller.close();
      },
    });
    const parts = await collectSse(stream);
    const joined = parts.join('');
    assert.ok(joined.includes('"text"'), 'should emit text SSE event');
    assert.ok(joined.includes('pong'), 'should include the assistant content');
    // No fallback should be present (no event: status with external_fallback reason)
    assert.ok(!joined.includes('external_fallback'));
  });

  it('post-dispatch: status=aborted → emits error SSE (NOT fallback to codex)', async () => {
    const client = new ScriptedMavisClient({
      info: [
        // First call: pre-poll probe (started)
        { session: { sessionId: 'mvs_1', agentName: 'mavis', agentRole: 'agent', displayName: 'mavis', title: 'mavis:t', status: 'started', lastActiveAt: new Date().toISOString(), model } },
        // Second call: inside poll loop, terminal aborted
        { session: { sessionId: 'mvs_1', agentName: 'mavis', agentRole: 'agent', displayName: 'mavis', title: 'mavis:t', status: 'aborted', model } },
      ],
      messages: [[]],
      diffs: [[]],
    });
    const provider = new MavisExecutorProvider({
      client,
      config: baseConfig,
      agentName: 'mavis',
      pollIntervalMs: 10,
      hardTimeoutMs: 1_000,
      quietTimeoutMs: 500,
      maxDiffBytes: 1024,
    });
    await provider.preDispatch(params());
    const stream = new ReadableStream<string>({
      start: async (controller) => {
        await provider.streamUntilFinish(params(), provider.binding!, controller);
        controller.close();
      },
    });
    const parts = await collectSse(stream);
    const joined = parts.join('');
    assert.ok(joined.includes('aborted'), 'should emit aborted error code');
    assert.ok(!joined.includes('"text"'), 'should NOT emit text on abort');
  });

  it('@hint strictly wins over sessionDefault (caller folding, v3.3 P1 + v3.4 残留 P2)', () => {
    // Reproduces the caller-side rule that the design requires:
    //   requestedExecutorId = hintedExecutorId ?? sessionDefaultId ?? undefined
    // Caller folds it BEFORE calling the registry. This test pins the rule.
    const compute = (hinted: string | undefined, sessionDefault: string | undefined): string | undefined =>
      hinted ?? sessionDefault ?? undefined;

    // user typed @codex + sessionDefault=mavis-agent → still route to codex
    assert.equal(compute('codex', 'mavis-agent'), 'codex');
    // user typed @mavis + sessionDefault=codex → mavis
    assert.equal(compute('mavis-agent', 'codex'), 'mavis-agent');
    // no hint + sessionDefault=mavis-agent → mavis (fallback)
    assert.equal(compute(undefined, 'mavis-agent'), 'mavis-agent');
    // nothing at all → undefined
    assert.equal(compute(undefined, undefined), undefined);
  });

  // v3.8 P2 fix: explicit per-terminal retryability for the external
  // dispatch path. The previous implementation routed every non-`finished`
  // terminal through `shouldAutoRetryWorkflowError(workflowFailureError)`
  // (generic text heuristic that defaults to `true` for unknown errors),
  // which meant an `aborted` turn would still enter
  // `requestWorkflowRetry('auto')` and the daemon would claim and
  // re-execute a cancelled prompt. These two tests pin the per-terminal
  // behavior end-to-end through HubLlmProvider → streamExternalDispatch
  // → workflow-runs.json.
  describe('v3.8 P2 — explicit per-terminal retryability', () => {
    function readWorkflowRunsFile(): { runs: Array<Record<string, unknown>> } {
      // workflow-status.ts writes to `${CTI_HOME}/runtime/workflow-runs.json`
      // (NOT `workflow-status.json` — the run-tests.mjs harness sets
      // CTI_HOME to its own tmp dir per `npm test` invocation, which
      // may differ from this suite's `hlpTmpHome`).
      const ctiHome = process.env.CTI_HOME;
      if (!ctiHome) throw new Error('CTI_HOME must be set by the test harness');
      const statusFile = path.join(ctiHome, 'runtime', 'workflow-runs.json');
      return JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
    }

    function makeMockMavisProvider(terminalReturn: 'aborted' | 'timeout'): unknown {
      // Minimal duck-typed object that satisfies what
      // `streamExternalDispatch` actually touches on the provider:
      //   - `preDispatch(params)` — must not throw
      //   - `binding` — non-null so streamUntilFinish branch is taken
      //   - `streamUntilFinish(params, binding, controller)` — returns
      //     the structured MavisStreamResult AND mirrors the real
      //     MavisExecutorProvider's behaviour of enqueueing the
      //     terminal error SSE event onto the controller (the
      //     user-visible signal that the turn failed). Without this
      //     enqueue the integration test would never see the
      //     `aborted` / `timeout` text on the wire.
      const preDispatch = async () => { /* no-op */ };
      const binding = {
        bridgeSessionId: 'bridge-v38',
        mvsSessionId: 'mvs_v38_1',
        agentName: 'mavis',
        createdAt: new Date().toISOString(),
        lastTurnAt: new Date().toISOString(),
        lastDispatchAt: new Date().toISOString(),
        model: { provider_id: 'mavis', model_id: 'sonnet' },
      };
      const streamUntilFinish = async (_params: unknown, _binding: unknown, controller: { enqueue: (value: string) => void }) => {
        if (terminalReturn === 'aborted') {
          controller.enqueue(
            `event: error\ndata: ${JSON.stringify({ code: 'aborted', short: '任务被中止' })}\n\n`,
          );
          return { terminal: 'aborted', errorCode: 'aborted', errorShort: '任务被中止' };
        }
        controller.enqueue(
          `event: error\ndata: ${JSON.stringify({ code: 'timeout', short: '远端调用超时' })}\n\n`,
        );
        return { terminal: 'timeout', errorCode: 'timeout', errorShort: '远端调用超时' };
      };
      // streamChat is a no-op ReadableStream — not exercised in this path
      // (streamExternalDispatch uses preDispatch + streamUntilFinish
      // exclusively when both are exposed).
      const streamChat = () => new ReadableStream<string>({ start(c) { c.close(); } });
      return { preDispatch, binding, streamUntilFinish, streamChat };
    }

    function makeRegistryForMock(mockProvider: unknown): ExecutorProviderRegistry {
      // Use the existing ExecutorProviderRegistry. We need a fake selection
      // whose `executor.id === 'mavis-agent'` so `streamExternalDispatch`
      // exercises the Mavis path. The cleanest way: register the mock
      // under 'mavis-agent' and craft an ExecutorRequest with
      // `requestedExecutorId: 'mavis-agent'` so the registry picks it.
      const registry = new ExecutorProviderRegistry();
      registry.register('mavis-agent', mockProvider as never);
      return registry;
    }

    it('aborted turn → workflow status=failed, retry.status !== auto_pending (NO auto-retry)', async () => {
      // We need HubLlmProvider's streamExternalDispatch path to run.
      // Easiest: construct a HubLlmProvider with a mock executorRegistry
      // that always resolves to our scripted mock provider.
      const { HubLlmProvider } = await import('../main.js');
      const { OllamaProvider } = await import('../local-llm-provider.js');
      const { LocalAgentProvider } = await import('../local-agent-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const { JsonFileStore } = await import('../store.js');

      // JsonFileStore auto-creates its data dir on construction; the
      // workflow status file path is resolved from `process.env.CTI_HOME`
      // at write time, which the `run-tests.mjs` harness sets to its
      // own tmp dir per `npm test` invocation.
      const store = new JsonFileStore(new Map());

      const localProvider = new OllamaProvider(baseConfig);
      const localAgent = new LocalAgentProvider(baseConfig, new PendingPermissions(), localProvider);
      const fallbackProvider = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };

      const mockProvider = makeMockMavisProvider('aborted');
      const registry = makeRegistryForMock(mockProvider);

      // Patch the registry's resolveForRequest so we can force a custom
      // selection (the real selection needs to be a v3.5 Selection with
      // executor.id === 'mavis-agent'). Build a minimal one.
      const originalResolve = registry.resolveForRequest.bind(registry);
      registry.resolveForRequest = ((config: Config, request: ExecutorRequest, fallback: LLMProvider) => {
        const real = originalResolve(config, request, fallback);
        if (real.isExternal) {
          return {
            ...real,
            provider: mockProvider as never,
          };
        }
        return real;
      });

      const hub = new HubLlmProvider(
        baseConfig,
        store,
        localProvider,
        localAgent,
        fallbackProvider as never,
        null,
        'codex',
        fallbackProvider as never,
        registry,
      );

      // Stream and drain so the ReadableStream start() callback (which
      // is where streamExternalDispatch lives) actually runs to its
      // `finally`.
      const stream = hub.streamChat(params({ sessionId: 'bridge-v38-aborted', prompt: '@mavis do thing' }));
      const parts = await collectSse(stream);
      const joined = parts.join('');
      assert.ok(joined.includes('aborted'), 'user-visible SSE must report the aborted terminal');

      // Now read the workflow status file and verify retry state.
      const wf = readWorkflowRunsFile();
      const run = wf.runs[wf.runs.length - 1];
      assert.equal(run?.status, 'failed', 'workflow run must be marked failed');
      const retryStatus = (run?.retry as { status?: string } | undefined)?.status;
      // Must NOT be auto_pending (or manual_pending) — aborted should
      // hard-fail without queuing a retry.
      assert.notEqual(retryStatus, 'auto_pending', 'aborted must NOT enter auto-pending retry queue');
      assert.notEqual(retryStatus, 'manual_pending', 'aborted must NOT enter manual-pending retry queue');
      assert.notEqual(retryStatus, 'retrying', 'aborted must NOT be in retrying state');
    });

    it('timeout turn → workflow status=failed, retry.status !== auto_pending (NO auto-retry)', async () => {
      const { HubLlmProvider } = await import('../main.js');
      const { OllamaProvider } = await import('../local-llm-provider.js');
      const { LocalAgentProvider } = await import('../local-agent-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const { JsonFileStore } = await import('../store.js');

      const store = new JsonFileStore(new Map());

      const localProvider = new OllamaProvider(baseConfig);
      const localAgent = new LocalAgentProvider(baseConfig, new PendingPermissions(), localProvider);
      const fallbackProvider = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };

      const mockProvider = makeMockMavisProvider('timeout');
      const registry = makeRegistryForMock(mockProvider);
      const originalResolve = registry.resolveForRequest.bind(registry);
      registry.resolveForRequest = ((config: Config, request: ExecutorRequest, fallback: LLMProvider) => {
        const real = originalResolve(config, request, fallback);
        if (real.isExternal) {
          return {
            ...real,
            provider: mockProvider as never,
          };
        }
        return real;
      });

      const hub = new HubLlmProvider(
        baseConfig,
        store,
        localProvider,
        localAgent,
        fallbackProvider as never,
        null,
        'codex',
        fallbackProvider as never,
        registry,
      );

      const stream = hub.streamChat(params({ sessionId: 'bridge-v38-timeout', prompt: '@mavis do thing' }));
      const parts = await collectSse(stream);
      const joined = parts.join('');
      assert.ok(joined.includes('timeout'), 'user-visible SSE must report the timeout terminal');

      const wf = readWorkflowRunsFile();
      const run = wf.runs[wf.runs.length - 1];
      assert.equal(run?.status, 'failed', 'timeout must hard-fail without queuing auto-retry');
      const retryStatus = (run?.retry as { status?: string } | undefined)?.status;
      assert.notEqual(retryStatus, 'auto_pending', 'timeout must NOT be marked auto_pending in the retry queue');
      assert.notEqual(retryStatus, 'manual_pending', 'timeout must NOT enter manual-pending retry queue');
      assert.notEqual(retryStatus, 'retrying', 'timeout must NOT be in retrying state');
    });
  });
});
