import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── SSE utils tests ─────────────────────────────────────────

import { sseEvent } from '../sse-utils.js';

describe('sseEvent', () => {
  it('formats a string data payload', () => {
    const result = sseEvent('text', 'hello');
    assert.equal(result, 'data: {"type":"text","data":"hello"}\n');
  });

  it('stringifies object data payload', () => {
    const result = sseEvent('result', { usage: { input_tokens: 10 } });
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.type, 'result');
    const inner = JSON.parse(parsed.data);
    assert.equal(inner.usage.input_tokens, 10);
  });

  it('handles newlines in data', () => {
    const result = sseEvent('text', 'line1\nline2');
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.data, 'line1\nline2');
  });
});

// ── CodexProvider tests ─────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

describe('CodexProvider', () => {
  it('adds explicit reply style context to normal Codex turns', async () => {
    const { buildTurnPrompt } = await import('../codex-provider.js');
    const prompt = buildTurnPrompt({
      prompt: '看一下项目状态',
      sessionId: 'style-session',
      replyPresentation: {
        replyStyleHint: '像项目助理，先说结果，再说一句影响',
      },
    });

    assert.match(prompt, /Bridge reply style/);
    assert.match(prompt, /Required custom reply style: 像项目助理/);
  });

  it('builds Codex client options from explicit API settings without leaking unrelated env', async () => {
    const oldBaseUrl = process.env.CTI_CODEX_BASE_URL;
    const oldApiKey = process.env.CTI_CODEX_API_KEY;
    const oldModel = process.env.CTI_CODEX_MODEL;
    const oldPassModel = process.env.CTI_CODEX_PASS_MODEL;
    const oldEffort = process.env.CTI_CODEX_REASONING_EFFORT;
    process.env.CTI_CODEX_BASE_URL = 'https://codex.example.test/v1';
    process.env.CTI_CODEX_API_KEY = 'codex-secret';
    process.env.CTI_CODEX_MODEL = 'gpt-local';
    process.env.CTI_CODEX_PASS_MODEL = 'true';
    process.env.CTI_CODEX_REASONING_EFFORT = 'medium';
    try {
      const { buildCodexClientOptionsForTest } = await import('../codex-provider.js');
      const options = buildCodexClientOptionsForTest();

      assert.equal(options.apiKey, 'codex-secret');
      assert.equal(options.baseUrl, 'https://codex.example.test/v1');
      assert.equal(options.config.model_reasoning_effort, 'medium');
      assert.equal(options.env.CODEX_HOME, process.env.CODEX_HOME);
      assert.equal(options.modelOverride, 'gpt-local');
      assert.equal(options.passModel, true);
    } finally {
      if (oldBaseUrl === undefined) delete process.env.CTI_CODEX_BASE_URL;
      else process.env.CTI_CODEX_BASE_URL = oldBaseUrl;
      if (oldApiKey === undefined) delete process.env.CTI_CODEX_API_KEY;
      else process.env.CTI_CODEX_API_KEY = oldApiKey;
      if (oldModel === undefined) delete process.env.CTI_CODEX_MODEL;
      else process.env.CTI_CODEX_MODEL = oldModel;
      if (oldPassModel === undefined) delete process.env.CTI_CODEX_PASS_MODEL;
      else process.env.CTI_CODEX_PASS_MODEL = oldPassModel;
      if (oldEffort === undefined) delete process.env.CTI_CODEX_REASONING_EFFORT;
      else process.env.CTI_CODEX_REASONING_EFFORT = oldEffort;
    }
  });

  it('isolates bridge Codex config from global MCP servers by default', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const saved = {
      globalHome: process.env.CTI_CODEX_GLOBAL_HOME,
      bridgeHome: process.env.CTI_CODEX_HOME,
      inheritMcp: process.env.CTI_CODEX_INHERIT_GLOBAL_MCP,
      codeHome: process.env.CODEX_HOME,
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-codex-mcp-isolation-'));
    const globalHome = path.join(root, 'global');
    const bridgeHome = path.join(root, 'bridge');
    fs.mkdirSync(globalHome, { recursive: true });
    fs.writeFileSync(path.join(globalHome, 'auth.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(globalHome, 'config.toml'), [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "high"',
      '[features]',
      'rmcp_client = true',
      '[mcp_servers.unityMCP]',
      'url = "http://127.0.0.1:8081/mcp"',
      '[projects.\'C:\\\\unity\\\\ST3\']',
      'trust_level = "trusted"',
    ].join('\n'), 'utf-8');
    process.env.CTI_CODEX_GLOBAL_HOME = globalHome;
    process.env.CTI_CODEX_HOME = bridgeHome;
    delete process.env.CTI_CODEX_INHERIT_GLOBAL_MCP;
    try {
      const { buildCodexClientOptionsForTest } = await import('../codex-provider.js');
      const options = buildCodexClientOptionsForTest('primary');
      const bridgeConfig = fs.readFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf-8');

      assert.equal(options.env.CODEX_HOME, bridgeHome);
      assert.ok(!bridgeConfig.includes('[mcp_servers.unityMCP]'));
      assert.ok(!bridgeConfig.includes('rmcp_client'));
      assert.ok(bridgeConfig.includes("[projects.'C:\\\\unity\\\\ST3']"));
      assert.ok(bridgeConfig.includes('model_reasoning_effort'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (saved.globalHome === undefined) delete process.env.CTI_CODEX_GLOBAL_HOME;
      else process.env.CTI_CODEX_GLOBAL_HOME = saved.globalHome;
      if (saved.bridgeHome === undefined) delete process.env.CTI_CODEX_HOME;
      else process.env.CTI_CODEX_HOME = saved.bridgeHome;
      if (saved.inheritMcp === undefined) delete process.env.CTI_CODEX_INHERIT_GLOBAL_MCP;
      else process.env.CTI_CODEX_INHERIT_GLOBAL_MCP = saved.inheritMcp;
      if (saved.codeHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.codeHome;
    }
  });

  it('builds local fallback Codex options from local AI settings and isolates CODEX_HOME', async () => {
    const saved = {
      localKind: process.env.CTI_LOCAL_AI_KIND,
      localBaseUrl: process.env.CTI_LOCAL_AI_BASE_URL,
      localApiKey: process.env.CTI_LOCAL_AI_API_KEY,
      localModel: process.env.CTI_LOCAL_AI_MODEL,
      localEffort: process.env.CTI_CODEX_LOCAL_FALLBACK_REASONING_EFFORT,
      localHome: process.env.CTI_CODEX_LOCAL_FALLBACK_HOME,
      codeHome: process.env.CODEX_HOME,
      openAiKey: process.env.OPENAI_API_KEY,
      codexApiKey: process.env.CODEX_API_KEY,
      ctiCodexApiKey: process.env.CTI_CODEX_API_KEY,
      ctiCodexBaseUrl: process.env.CTI_CODEX_BASE_URL,
    };
    const tempHome = await import('node:os').then(os => import('node:path').then(path => path.join(os.tmpdir(), `cti-codex-local-${Date.now()}`)));
    process.env.CTI_LOCAL_AI_KIND = 'ollama';
    process.env.CTI_LOCAL_AI_BASE_URL = 'http://127.0.0.1:11434';
    process.env.CTI_LOCAL_AI_API_KEY = 'local-secret';
    process.env.CTI_LOCAL_AI_MODEL = 'qwen3:8b';
    process.env.CTI_CODEX_LOCAL_FALLBACK_REASONING_EFFORT = 'minimal';
    process.env.CTI_CODEX_LOCAL_FALLBACK_HOME = tempHome;
    process.env.OPENAI_API_KEY = 'paid-openai-secret';
    process.env.CODEX_API_KEY = 'paid-codex-secret';
    process.env.CTI_CODEX_API_KEY = 'paid-cti-codex-secret';
    process.env.CTI_CODEX_BASE_URL = 'https://paid.example.test/v1';
    try {
      const { buildCodexClientOptionsForTest } = await import('../codex-provider.js');
      const options = buildCodexClientOptionsForTest('local_fallback');

      assert.equal(options.profile, 'local_fallback');
      assert.equal(options.apiKey, undefined);
      assert.equal(options.baseUrl, undefined);
      assert.equal(options.modelOverride, 'qwen3:8b');
      assert.equal(options.passModel, true);
      assert.equal(options.config.model_reasoning_effort, 'minimal');
      assert.equal(options.env.CODEX_HOME, tempHome);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.CODEX_API_KEY, undefined);
      assert.equal(options.env.CTI_CODEX_API_KEY, undefined);
      assert.equal(options.env.CTI_CODEX_BASE_URL, undefined);
      assert.equal(process.env.CODEX_HOME, tempHome);
    } finally {
      const fs = await import('node:fs');
      fs.rmSync(tempHome, { recursive: true, force: true });
      if (saved.localKind === undefined) delete process.env.CTI_LOCAL_AI_KIND;
      else process.env.CTI_LOCAL_AI_KIND = saved.localKind;
      if (saved.localBaseUrl === undefined) delete process.env.CTI_LOCAL_AI_BASE_URL;
      else process.env.CTI_LOCAL_AI_BASE_URL = saved.localBaseUrl;
      if (saved.localApiKey === undefined) delete process.env.CTI_LOCAL_AI_API_KEY;
      else process.env.CTI_LOCAL_AI_API_KEY = saved.localApiKey;
      if (saved.localModel === undefined) delete process.env.CTI_LOCAL_AI_MODEL;
      else process.env.CTI_LOCAL_AI_MODEL = saved.localModel;
      if (saved.localEffort === undefined) delete process.env.CTI_CODEX_LOCAL_FALLBACK_REASONING_EFFORT;
      else process.env.CTI_CODEX_LOCAL_FALLBACK_REASONING_EFFORT = saved.localEffort;
      if (saved.localHome === undefined) delete process.env.CTI_CODEX_LOCAL_FALLBACK_HOME;
      else process.env.CTI_CODEX_LOCAL_FALLBACK_HOME = saved.localHome;
      if (saved.codeHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.codeHome;
      if (saved.openAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.openAiKey;
      if (saved.codexApiKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = saved.codexApiKey;
      if (saved.ctiCodexApiKey === undefined) delete process.env.CTI_CODEX_API_KEY;
      else process.env.CTI_CODEX_API_KEY = saved.ctiCodexApiKey;
      if (saved.ctiCodexBaseUrl === undefined) delete process.env.CTI_CODEX_BASE_URL;
      else process.env.CTI_CODEX_BASE_URL = saved.ctiCodexBaseUrl;
    }
  });

  it('builds local primary Codex options from local AI settings without using fallback home', async () => {
    const saved = {
      localKind: process.env.CTI_LOCAL_AI_KIND,
      localBaseUrl: process.env.CTI_LOCAL_AI_BASE_URL,
      localApiKey: process.env.CTI_LOCAL_AI_API_KEY,
      localModel: process.env.CTI_LOCAL_AI_MODEL,
      localHome: process.env.CTI_CODEX_LOCAL_PRIMARY_HOME,
      globalHome: process.env.CTI_CODEX_GLOBAL_HOME,
      codeHome: process.env.CODEX_HOME,
      openAiKey: process.env.OPENAI_API_KEY,
      codexApiKey: process.env.CODEX_API_KEY,
      ctiCodexApiKey: process.env.CTI_CODEX_API_KEY,
      ctiCodexBaseUrl: process.env.CTI_CODEX_BASE_URL,
    };
    const tempHome = await import('node:os').then(os => import('node:path').then(path => path.join(os.tmpdir(), `cti-codex-local-primary-${Date.now()}`)));
    const globalHome = await import('node:os').then(os => import('node:path').then(path => path.join(os.tmpdir(), `cti-codex-global-${Date.now()}`)));
    process.env.CTI_LOCAL_AI_KIND = 'ollama';
    process.env.CTI_LOCAL_AI_BASE_URL = 'http://127.0.0.1:11434';
    delete process.env.CTI_LOCAL_AI_API_KEY;
    process.env.CTI_LOCAL_AI_MODEL = 'qwen3:14b';
    process.env.CTI_CODEX_LOCAL_PRIMARY_HOME = tempHome;
    process.env.CTI_CODEX_GLOBAL_HOME = globalHome;
    process.env.OPENAI_API_KEY = 'paid-openai-secret';
    process.env.CODEX_API_KEY = 'paid-codex-secret';
    process.env.CTI_CODEX_API_KEY = 'paid-cti-codex-secret';
    process.env.CTI_CODEX_BASE_URL = 'https://paid.example.test/v1';
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(path.join(globalHome, 'plugins', 'broken-plugin'), { recursive: true });
      fs.writeFileSync(path.join(globalHome, 'plugins', 'broken-plugin', 'plugin.json'), '{}', 'utf-8');
      fs.writeFileSync(path.join(globalHome, 'config.toml'), [
        'personality = "pragmatic"',
        'notify = ["some-plugin-hook"]',
        '',
        '[plugins."broken@openai-curated"]',
        'enabled = true',
        '',
        '[marketplaces.openai-curated]',
        'source_type = "git"',
        'source = "https://example.invalid/plugins.git"',
        '',
        '[desktop]',
        'localeOverride = "zh-CN"',
        '',
        '[memories]',
        'use_memories = true',
        '',
        "[projects.'C:\\\\unity\\\\ST3']",
        'trust_level = "trusted"',
      ].join('\n'), 'utf-8');
      const { buildCodexClientOptionsForTest } = await import('../codex-provider.js');
      const options = buildCodexClientOptionsForTest('local_primary');
      const bridgeConfig = fs.readFileSync(path.join(tempHome, 'config.toml'), 'utf-8');

      assert.equal(options.profile, 'local_primary');
      assert.equal(options.apiKey, undefined);
      assert.equal(options.baseUrl, undefined);
      assert.equal(options.modelOverride, 'qwen3:14b');
      assert.equal(options.passModel, true);
      assert.equal(options.env.CODEX_HOME, tempHome);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.CODEX_API_KEY, undefined);
      assert.equal(options.env.CTI_CODEX_API_KEY, undefined);
      assert.equal(options.env.CTI_CODEX_BASE_URL, undefined);
      assert.equal(process.env.CODEX_HOME, tempHome);
      assert.equal(fs.existsSync(path.join(tempHome, 'plugins')), false);
      assert.ok(!bridgeConfig.includes('[plugins.'));
      assert.ok(!bridgeConfig.includes('[marketplaces.'));
      assert.ok(!bridgeConfig.includes('personality ='));
      assert.ok(!bridgeConfig.includes('notify ='));
      assert.ok(!bridgeConfig.includes('[desktop]'));
      assert.ok(!bridgeConfig.includes('[memories]'));
      assert.ok(bridgeConfig.includes("[projects.'C:\\\\unity\\\\ST3']"));
    } finally {
      const fs = await import('node:fs');
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(globalHome, { recursive: true, force: true });
      if (saved.localKind === undefined) delete process.env.CTI_LOCAL_AI_KIND;
      else process.env.CTI_LOCAL_AI_KIND = saved.localKind;
      if (saved.localBaseUrl === undefined) delete process.env.CTI_LOCAL_AI_BASE_URL;
      else process.env.CTI_LOCAL_AI_BASE_URL = saved.localBaseUrl;
      if (saved.localApiKey === undefined) delete process.env.CTI_LOCAL_AI_API_KEY;
      else process.env.CTI_LOCAL_AI_API_KEY = saved.localApiKey;
      if (saved.localModel === undefined) delete process.env.CTI_LOCAL_AI_MODEL;
      else process.env.CTI_LOCAL_AI_MODEL = saved.localModel;
      if (saved.localHome === undefined) delete process.env.CTI_CODEX_LOCAL_PRIMARY_HOME;
      else process.env.CTI_CODEX_LOCAL_PRIMARY_HOME = saved.localHome;
      if (saved.globalHome === undefined) delete process.env.CTI_CODEX_GLOBAL_HOME;
      else process.env.CTI_CODEX_GLOBAL_HOME = saved.globalHome;
      if (saved.codeHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.codeHome;
      if (saved.openAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.openAiKey;
      if (saved.codexApiKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = saved.codexApiKey;
      if (saved.ctiCodexApiKey === undefined) delete process.env.CTI_CODEX_API_KEY;
      else process.env.CTI_CODEX_API_KEY = saved.ctiCodexApiKey;
      if (saved.ctiCodexBaseUrl === undefined) delete process.env.CTI_CODEX_BASE_URL;
      else process.env.CTI_CODEX_BASE_URL = saved.ctiCodexBaseUrl;
    }
  });

  it('emits error when SDK init fails', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Force ensureSDK to fail by setting sdk to a broken module
    (provider as any).sdk = { Codex: class { constructor() { throw new Error('Missing API key'); } } };
    (provider as any).codex = null;
    // Reset so ensureSDK re-runs the constructor
    (provider as any).sdk = null;
    // Override ensureSDK directly
    (provider as any).ensureSDK = async () => { throw new Error('SDK init failed: Missing API key'); };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.ok(errorEvent!.data.includes('Missing API key'), 'Error should contain the cause');
  });

  it('maps agent_message item to text SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-1',
      text: 'Hello from Codex!',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Hello from Codex!');
  });

  it('maps command_execution item to tool_use + tool_result', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'ls -la',
      aggregated_output: 'file1.txt\nfile2.txt',
      exit_code: 0,
      status: 'completed',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);

    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Bash');
    assert.equal(toolUse.input.command, 'ls -la');

    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.tool_use_id, 'cmd-1');
    assert.equal(toolResult.is_error, false);
  });

  it('marks non-zero exit code as error', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-2',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.is_error, true);
  });

  it('maps file_change item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'file_change',
      id: 'fc-1',
      changes: [
        { path: 'src/main.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Edit');
    const toolResult = JSON.parse(events[1].data);
    assert.ok(toolResult.content.includes('update: src/main.ts'));
  });

  it('maps mcp_tool_call item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-1',
      server: 'myserver',
      tool: 'search',
      arguments: { query: 'test' },
      result: { content: 'found 3 results' },
    });

    const events = parseSSEChunks(chunks);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'mcp__myserver__search');
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, 'found 3 results');
  });

  it('maps mcp_tool_call with structured_content', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-2',
      server: 'myserver',
      tool: 'getData',
      arguments: {},
      result: { structured_content: { items: [1, 2, 3] } },
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, JSON.stringify({ items: [1, 2, 3] }));
  });

  it('skips empty agent_message', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-2',
      text: '',
    });

    assert.equal(chunks.length, 0);
  });

  it('does not pass model by default and still attempts resume for persisted thread ids', async () => {
    const oldResume = process.env.CTI_CODEX_RESUME_THREADS;
    process.env.CTI_CODEX_RESUME_THREADS = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let resumeCalls = 0;
      let startCalls = 0;
      let resumedThreadId: string | undefined;
      let capturedResumeOptions: Record<string, unknown> | undefined;

      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        resumeThread: (threadId: string, options: Record<string, unknown>) => {
          resumeCalls += 1;
          resumedThreadId = threadId;
          capturedResumeOptions = options;
          return mockThread;
        },
        startThread: (_opts: Record<string, unknown>) => {
          startCalls += 1;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'model-default-session',
        sdkSessionId: 'old-claude-session-id',
        model: 'claude-sonnet-4-20250514',
      });

      await collectStream(stream);

      assert.equal(resumeCalls, 1, 'Should attempt resume for the persisted thread id');
      assert.equal(resumedThreadId, 'old-claude-session-id');
      assert.equal(startCalls, 0, 'Should not eagerly start a fresh thread when resume is available');
      assert.ok(capturedResumeOptions, 'resumeThread options should be captured');
      assert.ok(!Object.prototype.hasOwnProperty.call(capturedResumeOptions!, 'model'), 'Model should not be forwarded by default');
    } finally {
      if (oldResume === undefined) {
        delete process.env.CTI_CODEX_RESUME_THREADS;
      } else {
        process.env.CTI_CODEX_RESUME_THREADS = oldResume;
      }
    }
  });

  it('reuses the in-memory Codex thread even when the stored model is Claude-like', async () => {
    const oldResume = process.env.CTI_CODEX_RESUME_THREADS;
    process.env.CTI_CODEX_RESUME_THREADS = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let resumeCalls = 0;
      let startCalls = 0;
      let resumedThreadId: string | undefined;

      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };

      (provider as any).threadIds.set('sticky-codex-session', 'codex-thread-123');
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        resumeThread: (threadId: string) => {
          resumeCalls += 1;
          resumedThreadId = threadId;
          return mockThread;
        },
        startThread: () => {
          startCalls += 1;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'continue previous thread',
        sessionId: 'sticky-codex-session',
        sdkSessionId: 'old-claude-session-id',
        model: 'claude-sonnet-4-20250514',
      });

      await collectStream(stream);

      assert.equal(resumeCalls, 1, 'Should resume the in-memory Codex thread');
      assert.equal(resumedThreadId, 'codex-thread-123');
      assert.equal(startCalls, 0, 'Should not start a fresh thread when an in-memory Codex thread exists');
    } finally {
      if (oldResume === undefined) {
        delete process.env.CTI_CODEX_RESUME_THREADS;
      } else {
        process.env.CTI_CODEX_RESUME_THREADS = oldResume;
      }
    }
  });

  it('passes model only when CTI_CODEX_PASS_MODEL=true', async () => {
    const old = process.env.CTI_CODEX_PASS_MODEL;
    process.env.CTI_CODEX_PASS_MODEL = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'model-forward-session',
        model: 'gpt-5-codex',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.model, 'gpt-5-codex');
    } finally {
      if (old === undefined) {
        delete process.env.CTI_CODEX_PASS_MODEL;
      } else {
        process.env.CTI_CODEX_PASS_MODEL = old;
      }
    }
  });

  it('uses CTI_CODEX_MODEL override before bridge model forwarding', async () => {
    const oldPassModel = process.env.CTI_CODEX_PASS_MODEL;
    const oldOverride = process.env.CTI_CODEX_MODEL;
    process.env.CTI_CODEX_PASS_MODEL = 'true';
    process.env.CTI_CODEX_MODEL = 'gpt-5.4';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'model-override-session',
        model: 'gpt-5.5',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.model, 'gpt-5.4');
    } finally {
      if (oldPassModel === undefined) {
        delete process.env.CTI_CODEX_PASS_MODEL;
      } else {
        process.env.CTI_CODEX_PASS_MODEL = oldPassModel;
      }
      if (oldOverride === undefined) {
        delete process.env.CTI_CODEX_MODEL;
      } else {
        process.env.CTI_CODEX_MODEL = oldOverride;
      }
    }
  });

  it('passes skipGitRepoCheck only when CTI_CODEX_SKIP_GIT_REPO_CHECK=true', async () => {
    const old = process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
    process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'skip-git-check-session',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.skipGitRepoCheck, true);
    } finally {
      if (old === undefined) {
        delete process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
      } else {
        process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = old;
      }
    }
  });

  it('passes additionalDirectories through to thread options', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedStartOptions: Record<string, unknown> | undefined;
    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: (opts: Record<string, unknown>) => {
        capturedStartOptions = opts;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'additional-directories-session',
      workingDirectory: 'C:\\Users\\admin\\Documents\\New project',
      additionalDirectories: ['E:\\cli-md', 'F:\\unity', 'E:\\cli-md'],
    });
    await collectStream(stream);

    assert.deepEqual(
      capturedStartOptions?.additionalDirectories,
      ['E:\\cli-md', 'F:\\unity'],
    );
  });

  it('falls back to CTI_DEFAULT_WORKDIR when the requested workingDirectory is missing and drops missing additionalDirectories', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const provider = new CodexProvider(new PendingPermissions());

    const originalDefaultWorkdir = process.env.CTI_DEFAULT_WORKDIR;
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-codex-fallback-'));
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-codex-extra-'));
    process.env.CTI_DEFAULT_WORKDIR = fallbackDir;

    let capturedStartOptions: Record<string, unknown> | undefined;
    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: (opts: Record<string, unknown>) => {
        capturedStartOptions = opts;
        return mockThread;
      },
    };

    try {
      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'missing-working-directory-session',
        workingDirectory: 'C:\\workspace',
        additionalDirectories: [extraDir, 'C:\\workspace\\missing-dir', extraDir],
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.workingDirectory, fallbackDir);
      assert.deepEqual(capturedStartOptions?.additionalDirectories, [extraDir]);
    } finally {
      fs.rmSync(fallbackDir, { recursive: true, force: true });
      fs.rmSync(extraDir, { recursive: true, force: true });
      if (originalDefaultWorkdir === undefined) {
        delete process.env.CTI_DEFAULT_WORKDIR;
      } else {
        process.env.CTI_DEFAULT_WORKDIR = originalDefaultWorkdir;
      }
    }
  });

  it('retries with fresh thread when resume fails before any events', async () => {
    const oldResume = process.env.CTI_CODEX_RESUME_THREADS;
    process.env.CTI_CODEX_RESUME_THREADS = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let resumeCalls = 0;
      let startCalls = 0;
      const resumeThread = {
        runStreamed: async () => {
          throw new Error('resuming session with different model');
        },
      };
      const freshThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 0 } };
          })(),
        }),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        resumeThread: () => {
          resumeCalls += 1;
          return resumeThread;
        },
        startThread: () => {
          startCalls += 1;
          return freshThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'retry test',
        sessionId: 'resume-retry-session',
        sdkSessionId: 'codex-old-thread-id',
        model: 'gpt-5-codex',
      });

      const chunks = await collectStream(stream);
      const events = parseSSEChunks(chunks);
      const errorEvent = events.find(e => e.type === 'error');
      const resultEvent = events.find(e => e.type === 'result');

      assert.equal(resumeCalls, 1, 'Should attempt resume once');
      assert.equal(startCalls, 1, 'Should fall back to a fresh thread');
      assert.ok(!errorEvent, 'Retry success should not emit error');
      assert.ok(resultEvent, 'Retry success should emit result');
    } finally {
      if (oldResume === undefined) {
        delete process.env.CTI_CODEX_RESUME_THREADS;
      } else {
        process.env.CTI_CODEX_RESUME_THREADS = oldResume;
      }
    }
  });
});

// ── Image input building tests ──────────────────────────────

import fs from 'node:fs';

/** Helper: build a full FileAttachment object for tests. */
function makeFile(type: string, data: string, name = 'test-file') {
  return { id: `file-${Date.now()}`, name, type, size: data.length, data };
}

describe('CodexProvider image input', () => {
  it('builds local_image input array for text+image', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Mock the SDK so we can capture the input passed to runStreamed
    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    // Use valid base64 (1x1 red PNG pixel)
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const stream = provider.streamChat({
      prompt: 'Describe this image',
      sessionId: 'img-session',
      files: [makeFile('image/png', pngBase64, 'test.png')],
    });

    await collectStream(stream);

    assert.ok(Array.isArray(capturedInput), 'Input should be an array for image input');
    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'text');
    assert.match(parts[0].text, /Bridge reply contract:/);
    assert.match(parts[0].text, /not a helper giving the user homework/);
    assert.match(parts[0].text, /Current user request:\nDescribe this image$/);
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'), 'Temp file should have .png extension');
  });

  it('passes plain string when no images attached', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Hello',
      sessionId: 'no-img-session',
    });

    await collectStream(stream);

    assert.equal(typeof capturedInput, 'string', 'Input should be a plain string without images');
    assert.match(capturedInput as string, /Bridge reply contract:/);
    assert.match(capturedInput as string, /Do not answer executable tasks with generic instructions/);
    assert.match(capturedInput as string, /Current user request:\nHello$/);
  });

  it('builds local_image input with multiple images, ignoring non-image files', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Compare these',
      sessionId: 'multi-img-session',
      files: [
        makeFile('image/png', 'cG5n', 'a.png'),
        makeFile('image/jpeg', 'anBn', 'b.jpg'),
        makeFile('text/plain', 'dGV4dA==', 'c.txt'),
      ],
    });

    await collectStream(stream);

    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 3, 'Should have 1 text + 2 local_image parts (non-image file excluded)');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'));
    assert.equal(parts[2].type, 'local_image');
    assert.ok(parts[2].path.endsWith('.jpg'));
  });
});

// ── Error event tests ───────────────────────────────────────

describe('CodexProvider error events', () => {
  it('reads message field from turn.failed event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed', message: 'Rate limit exceeded' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-1',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Rate limit exceeded');
  });

  it('reads message field from error event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'error', message: 'Connection lost' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-2',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Connection lost');
  });

  it('falls back to default message when message field is absent', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-3',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent);
    assert.equal(errorEvent!.data, 'Turn failed');
  });
});
