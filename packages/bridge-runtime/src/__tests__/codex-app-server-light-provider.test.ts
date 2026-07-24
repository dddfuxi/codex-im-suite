import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { StreamChatParams } from 'claude-to-im/host';
import { CodexAppServerLightProvider } from '../codex-app-server-light-provider.js';
import { LIGHT_CONVERSATION_COORDINATOR_RESPONSE_SCHEMA } from '../local-llm-router.js';

type JsonRecord = Record<string, unknown>;

class FakeAppServerProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 12345;
  exitCode: number | null = null;
  killed = false;
  private inputBuffer = '';

  constructor(private readonly onRequest: (request: JsonRecord, process: FakeAppServerProcess) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.inputBuffer += String(chunk);
        while (true) {
          const newline = this.inputBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = this.inputBuffer.slice(0, newline).trim();
          this.inputBuffer = this.inputBuffer.slice(newline + 1);
          if (line) this.onRequest(JSON.parse(line) as JsonRecord, this);
        }
        callback();
      },
    });
  }

  send(...messages: JsonRecord[]): void {
    this.stdout.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  }

  kill(): boolean {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

async function collect(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output;
    output += value;
  }
}

function params(prompt = '哈喽'): StreamChatParams {
  return {
    prompt,
    sessionId: 'light-session',
    interactionMode: 'classifier',
    responseSchema: LIGHT_CONVERSATION_COORDINATOR_RESPONSE_SCHEMA,
    systemPrompt: '只输出轻聊协调 JSON。',
    abortController: new AbortController(),
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CodexAppServerLightProvider', () => {
  it('预热后复用同一会话线程，并正确处理同一 NDJSON 批次中的早到通知', async () => {
    const isolatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-app-server-test-'));
    tempDirs.push(isolatedDirectory);
    let threadStarts = 0;
    let turnStarts = 0;
    const fake = new FakeAppServerProcess((request, child) => {
      const id = request.id as number | undefined;
      const method = request.method;
      if (method === 'initialize') {
        child.send({ jsonrpc: '2.0', id, result: { userAgent: 'test', codexHome: isolatedDirectory } });
      } else if (method === 'thread/start') {
        threadStarts += 1;
        child.send({ jsonrpc: '2.0', id, result: { thread: { id: `thread-${threadStarts}` } } });
      } else if (method === 'turn/start') {
        turnStarts += 1;
        const turnId = `turn-${turnStarts}`;
        const reply = JSON.stringify({
          action: 'reply',
          intent: 'light_chat',
          reply: `快速回复-${turnStarts}`,
          reason: '普通轻聊',
          confidence: 0.99,
        });
        // 响应和通知故意放在同一 stdout 批次，覆盖真实进程可能出现的竞态。
        child.send(
          { jsonrpc: '2.0', id, result: { turn: { id: turnId } } },
          { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, itemId: 'item-1', delta: reply } },
          { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId, tokenUsage: { last: { inputTokens: 120, outputTokens: 20, cachedInputTokens: 80 } } } },
          { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] } } },
        );
      } else if (id !== undefined) {
        child.send({ jsonrpc: '2.0', id, result: {} });
      }
    });
    const provider = new CodexAppServerLightProvider({
      executablePath: 'fake-codex',
      isolatedDirectory,
      spawnProcess: () => fake,
      terminateProcess: (child) => { child.kill(); },
      rpcTimeoutMs: 500,
      turnTimeoutMs: 500,
    });

    await provider.warmup();
    const first = await collect(provider.streamChat(params()));
    const second = await collect(provider.streamChat(params('谢谢')));
    await provider.dispose();

    assert.equal(threadStarts, 1, '预热线程应直接分配给首个会话并继续复用');
    assert.equal(turnStarts, 2);
    assert.match(first, /codex_app_server/);
    assert.match(first, /快速回复-1/);
    assert.match(first, /input_tokens/);
    assert.match(second, /快速回复-2/);
  });

  it('拒绝 Agent 回合，不启动进程也不获得任何工具边界', async () => {
    const isolatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-app-server-test-'));
    tempDirs.push(isolatedDirectory);
    let spawnCalls = 0;
    const provider = new CodexAppServerLightProvider({
      executablePath: 'fake-codex',
      isolatedDirectory,
      spawnProcess: () => {
        spawnCalls += 1;
        throw new Error('不应启动');
      },
    });

    const output = await collect(provider.streamChat({
      ...params('帮我改文件'),
      interactionMode: 'agent',
    }));
    await provider.dispose();

    assert.equal(spawnCalls, 0);
    assert.match(output, /拒绝执行 Agent\/工具回合/);
  });

  it('一旦模型尝试工具就失败关闭，由上层保守交回 Primary', async () => {
    const isolatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-app-server-test-'));
    tempDirs.push(isolatedDirectory);
    const fake = new FakeAppServerProcess((request, child) => {
      const id = request.id as number | undefined;
      if (request.method === 'initialize') {
        child.send({ jsonrpc: '2.0', id, result: {} });
      } else if (request.method === 'thread/start') {
        child.send({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-safe' } } });
      } else if (request.method === 'turn/start') {
        child.send(
          { jsonrpc: '2.0', id, result: { turn: { id: 'turn-tool' } } },
          { method: 'item/started', params: { threadId: 'thread-safe', turnId: 'turn-tool', item: { type: 'commandExecution' } } },
        );
      } else if (id !== undefined) {
        child.send({ jsonrpc: '2.0', id, result: {} });
      }
    });
    const provider = new CodexAppServerLightProvider({
      executablePath: 'fake-codex',
      isolatedDirectory,
      spawnProcess: () => fake,
      terminateProcess: (child) => { child.kill(); },
      rpcTimeoutMs: 500,
      turnTimeoutMs: 500,
    });

    const output = await collect(provider.streamChat(params()));
    await provider.dispose();

    assert.match(output, /尝试了禁用工具：commandExecution/);
    assert.doesNotMatch(output, /"type":"text"/);
  });
});
