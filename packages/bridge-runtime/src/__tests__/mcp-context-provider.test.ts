import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/host';

import { PersistentMcpContextProvider } from '../mcp-context-provider.js';
import type { McpManifestRecord } from '../mcp-bridge.js';

function fakeStream(): ReadableStream<string> {
  return new ReadableStream<string>({ start(controller) { controller.close(); } });
}

function createCaptureProvider(calls: StreamChatParams[]): LLMProvider {
  return { streamChat(params) { calls.push(params); return fakeStream(); } };
}

function manifest(): McpManifestRecord {
  return {
    id: 'tapdMCP',
    displayName: 'TAPD MCP',
    type: 'stdio',
    enabled: true,
    manifestPath: 'tapd-mcp.json',
    context: {
      fields: [{
        name: 'company_id',
        aliases: ['companyId', '公司ID'],
        valuePattern: '^[0-9]{1,20}$',
      }],
    },
  };
}

function params(prompt: string, userId = 'user-1'): StreamChatParams {
  return {
    prompt,
    sessionId: 'session-1',
    sourceChannelType: 'feishu',
    sourceChatId: 'chat-1',
    sourceUserId: userId,
  };
}

describe('PersistentMcpContextProvider', () => {
  it('persists an explicit non-secret TAPD company id and injects it on later turns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-context-'));
    const filePath = path.join(root, 'runtime', 'mcp-context.json');
    try {
      const firstCalls: StreamChatParams[] = [];
      const first = new PersistentMcpContextProvider(createCaptureProvider(firstCalls), [manifest()], filePath);
      first.streamChat(params('查询 TAPD 标题，company_id=39238276'));
      assert.equal(firstCalls.length, 1);
      assert.match(firstCalls[0].priorityTurnContext || '', /company_id=39238276/u);

      const persisted = fs.readFileSync(filePath, 'utf8');
      assert.match(persisted, /39238276/u);
      assert.doesNotMatch(persisted, /token|secret|password/iu);

      const secondCalls: StreamChatParams[] = [];
      const second = new PersistentMcpContextProvider(createCaptureProvider(secondCalls), [manifest()], filePath);
      second.streamChat(params('本周 TAPD 单子标题列一下'));
      assert.equal(secondCalls.length, 1);
      assert.match(secondCalls[0].priorityTurnContext || '', /company_id=39238276/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps scopes isolated by chat and user and never persists credential-like fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-context-'));
    const filePath = path.join(root, 'runtime', 'mcp-context.json');
    const unsafeManifest = manifest();
    unsafeManifest.context = { fields: [
      ...(manifest().context?.fields || []),
      { name: 'access_token', aliases: ['token'], valuePattern: '.+' },
    ] };
    try {
      const firstCalls: StreamChatParams[] = [];
      const first = new PersistentMcpContextProvider(createCaptureProvider(firstCalls), [unsafeManifest], filePath);
      first.streamChat(params('TAPD companyId=43368716 token=do-not-save'));
      assert.match(firstCalls[0].priorityTurnContext || '', /company_id=43368716/u);
      assert.doesNotMatch(firstCalls[0].priorityTurnContext || '', /do-not-save|access_token/iu);

      const otherCalls: StreamChatParams[] = [];
      const other = new PersistentMcpContextProvider(createCaptureProvider(otherCalls), [unsafeManifest], filePath);
      other.streamChat(params('本周 TAPD 标题列一下', 'user-2'));
      assert.equal(otherCalls[0].priorityTurnContext, undefined);
      assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /do-not-save|access_token/iu);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not inject context into restricted classifier or response-only turns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-context-'));
    const filePath = path.join(root, 'runtime', 'mcp-context.json');
    try {
      const calls: StreamChatParams[] = [];
      const provider = new PersistentMcpContextProvider(createCaptureProvider(calls), [manifest()], filePath);
      provider.streamChat({ ...params('TAPD company_id=39238276'), interactionMode: 'classifier' });
      assert.equal(calls[0].priorityTurnContext, undefined);
      assert.equal(fs.existsSync(filePath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
