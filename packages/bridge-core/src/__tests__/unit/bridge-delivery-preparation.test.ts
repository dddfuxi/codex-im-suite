import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  compactBridgeReplyForDelivery,
  prepareDeliveryCandidate,
  stripDeliveryProtocolArtifacts,
} from '../../lib/bridge/application/delivery-preparation.js';

describe('bridge delivery preparation', () => {
  it('parses the last cti-final envelope with normalized mode, paths, mentions, and reply target', () => {
    const cwd = path.resolve('C:/workspace/project');
    const result = prepareDeliveryCandidate([
      '```cti-final',
      JSON.stringify({ kind: 'text', text: '旧结果', images: [], files: [], reply_mode: 'plain' }),
      '```',
      '```cti-final',
      JSON.stringify({
        kind: 'mixed',
        text: '最终结果',
        images: ['./result.png'],
        files: ['C:/artifacts/report.md'],
        reply_mode: 'markdown',
        mentions: ['乔治', { id: 'ou_target', user_name: '小明' }],
        reply_to: 'om_source',
      }),
      '```',
    ].join('\n'), cwd);

    assert.deepEqual(result.status, {
      parsed: true,
      kind: 'mixed',
      usedRawFallback: false,
      usedLegacyCompactor: false,
    });
    assert.equal(result.payload.text, '最终结果');
    assert.equal(result.payload.parseMode, 'Markdown');
    assert.deepEqual(result.payload.images, [path.resolve(cwd, './result.png')]);
    assert.deepEqual(result.payload.files, ['C:/artifacts/report.md']);
    assert.deepEqual(result.payload.mentions, [{ userId: 'ou_target', name: '小明' }]);
    assert.deepEqual(result.payload.mentionTargets, ['乔治', '小明']);
    assert.equal(result.payload.replyTo, 'om_source');
  });

  it('recovers a cti-final envelope from structured assistant text wrappers', () => {
    const wrapped = JSON.stringify([{ type: 'text', text: [
      '```cti-final',
      JSON.stringify({ kind: 'text', text: '包装内结果', images: [], files: [], reply_mode: 'html' }),
      '```',
    ].join('\n') }]);
    const result = prepareDeliveryCandidate(wrapped, 'C:/workspace');

    assert.equal(result.payload.text, '包装内结果');
    assert.equal(result.payload.parseMode, 'HTML');
    assert.equal(result.status.parsed, true);
  });

  it('parses a cti-final fence that is adjacent to a previous agent message', () => {
    const result = prepareDeliveryCandidate([
      '我来处理啦～',
      '```cti-final',
      JSON.stringify({
        kind: 'text',
        text: '@乔治 请回答当前汤面。',
        images: [],
        files: [],
        reply_mode: 'plain',
        mentions: [{ open_id: 'ou_george', name: '乔治' }],
      }),
      '```',
    ].join(''), 'C:/workspace');

    assert.equal(result.status.parsed, true);
    assert.equal(result.payload.text, '@乔治 请回答当前汤面。');
    assert.deepEqual(result.payload.mentions, [{ userId: 'ou_george', name: '乔治' }]);
    assert.doesNotMatch(result.payload.text, /cti-final|reply_mode|我来处理啦/u);
  });

  it('parses single-line and naked nested final reply objects', () => {
    const singleLine = prepareDeliveryCandidate(
      '进度```cti-final {"kind":"text","text":"单行结果","images":[],"files":[],"reply_mode":"plain"}```',
      'C:/workspace',
    );
    const naked = prepareDeliveryCandidate(
      '结果：{"kind":"text","text":"裸对象结果","images":[],"files":[],"reply_mode":"plain","mentions":[{"open_id":"ou_nested","name":"嵌套成员"}]}',
      'C:/workspace',
    );

    assert.equal(singleLine.status.parsed, true);
    assert.equal(singleLine.payload.text, '单行结果');
    assert.equal(naked.status.parsed, true);
    assert.equal(naked.payload.text, '裸对象结果');
    assert.deepEqual(naked.payload.mentions, [{ userId: 'ou_nested', name: '嵌套成员' }]);
  });

  it('removes machine-only action and sticker protocol blocks from visible fallback text', () => {
    const text = [
      '给用户看的结果。',
      '```cti-reminder',
      '{"task":"secret"}',
      '```',
      '```cti-sticker-annotation',
      '{"fileKey":"fk"}',
      '```',
    ].join('\n');

    assert.equal(stripDeliveryProtocolArtifacts(text), '给用户看的结果。');
    const result = prepareDeliveryCandidate(text, 'C:/workspace');
    assert.equal(result.payload.text, '给用户看的结果。');
    assert.equal(result.status.usedRawFallback, true);
  });

  it('compacts long process narration to the latest outcome lines', () => {
    const compacted = compactBridgeReplyForDelivery([
      '我先检查工作区。',
      '我正在运行构建。',
      '下一步检查日志。',
      '构建已完成。',
      '文件在 C:/workspace/report.md。',
    ].join('\n'));

    assert.doesNotMatch(compacted, /我先|我正在|下一步/u);
    assert.match(compacted, /构建已完成/u);
    assert.match(compacted, /report\.md/u);
  });

  it('rejects empty or malformed envelopes and falls back without leaking raw protocol JSON', () => {
    const result = prepareDeliveryCandidate([
      '最终仍然可读。',
      '```cti-final',
      '{"kind":"text","reply_mode":"plain"',
      '```',
    ].join('\n'), 'C:/workspace');

    assert.equal(result.status.parsed, false);
    assert.equal(result.payload.text, '最终仍然可读。');
    assert.doesNotMatch(result.payload.text, /cti-final|reply_mode/u);
  });

  it('strips malformed protocol fences even when they follow text on the same line', () => {
    const result = prepareDeliveryCandidate(
      '仍可见的结果。```cti-final {"kind":"text","reply_mode":"plain"```',
      'C:/workspace',
    );

    assert.equal(result.status.parsed, false);
    assert.equal(result.payload.text, '仍可见的结果。');
    assert.doesNotMatch(result.payload.text, /cti-final|reply_mode|kind/u);
  });
});
