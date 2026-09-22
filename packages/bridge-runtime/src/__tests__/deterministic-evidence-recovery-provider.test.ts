import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/host';

import { DeterministicEvidenceRecoveryProvider } from '../deterministic-evidence-recovery-provider.js';

function delegateProvider(onCall: (params: StreamChatParams) => void): LLMProvider {
  return {
    streamChat(params) {
      onCall(params);
      return new ReadableStream<string>({
        start(controller) {
          controller.enqueue('delegate');
          controller.close();
        },
      });
    },
  };
}

function makeWorkspacePlan(root: string): NonNullable<StreamChatParams['workspacePlan']> {
  return {
    version: 'cti-turn-workspace/v1',
    primaryWorkspace: {
      path: root,
      accessMode: 'read_only',
      evidenceIds: ['current_message'],
      reason: 'test workspace',
      expiresAfterTurn: true,
    },
    temporaryMounts: [],
    deniedRoots: [],
    resolvedFrom: 'session_binding',
    createdAt: '2026-07-24T00:00:00.000Z',
    expiresAfterTurn: true,
  };
}

async function collect(stream: ReadableStream<string>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function parseEvents(chunks: string[]): Array<{ type: string; data: unknown }> {
  return chunks.flatMap((chunk) => chunk.split(/\r?\n/u))
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      const outer = JSON.parse(line.slice(6)) as { type: string; data: string };
      let data: unknown = outer.data;
      try {
        data = JSON.parse(outer.data);
      } catch {
        // text 事件允许是普通字符串。
      }
      return { type: outer.type, data };
    });
}

function baseParams(root: string): StreamChatParams {
  return {
    prompt: '工作目录',
    sessionId: 'evidence-recovery-test',
    interactionMode: 'agent',
    workingDirectory: root,
    workspacePlan: makeWorkspacePlan(root),
    executionRequirement: {
      kind: 'local_read_required',
      reason: '需要读取当前工作目录',
      requiredToolFamilies: ['read'],
    },
  };
}

describe('DeterministicEvidenceRecoveryProvider', () => {
  it('keeps the first attempt under the original provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-recovery-first-'));
    let delegated = 0;
    try {
      const provider = new DeterministicEvidenceRecoveryProvider(delegateProvider(() => { delegated += 1; }));
      const chunks = await collect(provider.streamChat({ ...baseParams(root), noEvidenceRetryAttempted: false }));

      assert.equal(delegated, 1);
      assert.deepEqual(chunks, ['delegate']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a clear directory request with real read-only tool evidence on the retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-recovery-list-'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'packages'));
    let delegated = 0;
    try {
      const provider = new DeterministicEvidenceRecoveryProvider(delegateProvider(() => { delegated += 1; }));
      const events = parseEvents(await collect(provider.streamChat({
        ...baseParams(root),
        noEvidenceRetryAttempted: true,
      })));

      assert.equal(delegated, 0);
      assert.deepEqual(events.map((event) => event.type), ['tool_use', 'tool_result', 'status', 'text', 'result']);
      assert.equal((events[0].data as { name: string }).name, 'JsonTool:list_dir');
      const toolResult = events[1].data as { is_error: boolean; content: string };
      assert.equal(toolResult.is_error, false);
      assert.match(toolResult.content, /docs/);
      assert.match(toolResult.content, /packages/);
      assert.equal((events[2].data as { evidenceSatisfied: boolean }).evidenceSatisfied, true);
      assert.match(String(events[3].data), /```cti-final/);
      assert.match(String(events[3].data), /docs/);
      assert.match(String(events[3].data), /packages/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not downgrade tool or artifact requirements to local reads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-recovery-strong-'));
    let delegated = 0;
    try {
      const provider = new DeterministicEvidenceRecoveryProvider(delegateProvider(() => { delegated += 1; }));
      for (const kind of ['tool_required', 'artifact_required'] as const) {
        const chunks = await collect(provider.streamChat({
          ...baseParams(root),
          noEvidenceRetryAttempted: true,
          executionRequirement: {
            kind,
            reason: 'strong evidence required',
            requiredToolFamilies: ['mcp'],
          },
        }));
        assert.deepEqual(chunks, ['delegate']);
      }
      assert.equal(delegated, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('delegates ambiguous requests and never expands beyond the workspace plan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-recovery-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-recovery-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8');
    let delegated = 0;
    try {
      const provider = new DeterministicEvidenceRecoveryProvider(delegateProvider(() => { delegated += 1; }));
      assert.deepEqual(await collect(provider.streamChat({
        ...baseParams(root),
        prompt: '帮我看看',
        noEvidenceRetryAttempted: true,
      })), ['delegate']);

      assert.deepEqual(await collect(provider.streamChat({
        ...baseParams(root),
        prompt: `读取 "${path.join(outside, 'secret.txt')}"`,
        workingDirectory: outside,
        noEvidenceRetryAttempted: true,
      })), ['delegate']);
      assert.equal(delegated, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
