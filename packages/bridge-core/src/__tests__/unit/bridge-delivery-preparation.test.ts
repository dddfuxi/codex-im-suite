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

  it('只接受严格的结构化语音呈现 intent，拒绝模型、路径和平台字段', () => {
    const valid = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text', text: '语音结果', images: [], files: [], reply_mode: 'plain',
      speech: { mode: 'voice_only' },
    }), '```'].join('\n'), 'C:/workspace');
    const textOnly = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text', text: '文字结果', images: [], files: [], reply_mode: 'plain',
      speech: { mode: 'text_only' },
    }), '```'].join('\n'), 'C:/workspace');
    const forged = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text', text: '安全文字结果', images: [], files: [], reply_mode: 'plain',
      speech: { mode: 'voice_only', ttsModelId: 'forged', path: 'C:/unsafe.ogg', file_key: 'forged' },
    }), '```'].join('\n'), 'C:/workspace');
    const referenceVoice = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text', text: '创建音色', images: [], files: [], reply_mode: 'plain',
      speech_action: {
        action: 'create_reference_voice',
        profile_name: '我的参考音色',
        rights_basis: 'self_or_authorized',
        usage_scope: 'local_tts_only',
        clean_single_speaker_confirmed: true,
      },
    }), '```'].join('\n'), 'C:/workspace');
    const forgedReferenceVoice = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text', text: '伪造动作', images: [], files: [], reply_mode: 'plain',
      speech_action: {
        action: 'create_reference_voice', profile_name: '伪造', file_key: 'fk', path: 'C:/x.wav', provider: 'x',
      },
    }), '```'].join('\n'), 'C:/workspace');

    assert.deepEqual(valid.payload.speech, { mode: 'voice_only' });
    assert.deepEqual(textOnly.payload.speech, { mode: 'text_only' });
    assert.equal(forged.payload.speech, undefined);
    assert.deepEqual(referenceVoice.payload.speechAction, {
      action: 'create_reference_voice',
      profileName: '我的参考音色',
      rightsBasis: 'self_or_authorized',
      usageScope: 'local_tts_only',
      cleanSingleSpeakerConfirmed: true,
    });
    assert.equal(forgedReferenceVoice.payload.speechAction, undefined);
  });

  it('accepts a card hero only when it selects the same delivered image path', () => {
    const cwd = path.resolve('C:/workspace/project');
    const result = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'image',
      text: '剧情开始。',
      images: ['./scene.png'],
      files: [],
      reply_mode: 'markdown',
      card_hero: { image: './scene.png', alt: '  遗迹\n入口  ' },
    }), '```'].join('\n'), cwd);

    assert.deepEqual(result.payload.cardHero, {
      imagePath: path.resolve(cwd, './scene.png'),
      alt: '遗迹 入口',
    });
  });

  it('rejects forged image keys, urls, and paths outside the delivered images list', () => {
    for (const cardHero of [
      { image_key: 'img_v3_forged' },
      { image: 'https://example.com/banner.png' },
      { image: './other.png' },
    ]) {
      const result = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
        kind: 'image', text: '结果', images: ['./scene.png'], files: [], reply_mode: 'plain', card_hero: cardHero,
      }), '```'].join('\n'), 'C:/workspace');
      assert.equal(result.payload.cardHero, undefined);
    }
  });

  it('parses and bounds a generic analysis view without accepting platform fields', () => {
    const result = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text',
      text: '详细依据。',
      images: [],
      files: [],
      reply_mode: 'markdown',
      analysis_view: {
        title: '  服务盘面\n总览  ',
        verdict: '整体稳定，队列延迟需要继续观察。',
        tone: 'positive',
        card_json: { forged: true },
        metrics: Array.from({ length: 8 }, (_, index) => ({
          label: `指标 ${index + 1}`,
          value: `${index + 1}`,
          change: index === 0 ? '↑ 12%' : '持平',
          tone: index === 0 ? 'warning' : 'invalid-platform-color',
          callback_data: 'forged',
        })),
        sections: Array.from({ length: 6 }, (_, index) => ({
          title: `分区 ${index + 1}`,
          items: Array.from({ length: 7 }, (_item, itemIndex) => `观察 ${itemIndex + 1}`),
        })),
      },
    }), '```'].join('\n'), 'C:/workspace');

    assert.deepEqual(result.payload.analysisView?.title, '服务盘面 总览');
    assert.equal(result.payload.analysisView?.tone, 'positive');
    assert.equal(result.payload.analysisView?.metrics.length, 6);
    assert.deepEqual(result.payload.analysisView?.metrics[0], {
      label: '指标 1', value: '1', change: '↑ 12%', tone: 'warning',
    });
    assert.equal(result.payload.analysisView?.metrics[1].tone, 'neutral');
    assert.equal(result.payload.analysisView?.sections.length, 4);
    assert.equal(result.payload.analysisView?.sections[0].items.length, 5);
    assert.equal('cardJson' in (result.payload.analysisView || {}), false);
  });

  it('drops an analysis view that has no usable structured content', () => {
    const result = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text', text: '普通回复', images: [], files: [], reply_mode: 'plain',
      analysis_view: { title: '空盘面', verdict: '没有指标或分区', metrics: [], sections: [] },
    }), '```'].join('\n'), 'C:/workspace');

    assert.equal(result.payload.analysisView, undefined);
  });

  it('filters invalid rows before limits and merges duplicate visible sections', () => {
    const result = prepareDeliveryCandidate(['```cti-final', JSON.stringify({
      kind: 'text', text: '依据', images: [], files: [], reply_mode: 'markdown',
      analysis_view: {
        title: '稳定性盘面',
        verdict: '有效项不应被前置脏数据挤掉。',
        metrics: [
          null,
          { label: '', value: 'invalid' },
          { label: 'Bridge', value: '在线', tone: 'positive' },
          { label: ' bridge ', value: '重复值' },
          ...Array.from({ length: 6 }, (_, index) => ({ label: `有效 ${index + 1}`, value: `${index + 1}` })),
        ],
        sections: [
          { title: '风险', items: ['队列延迟', '队列延迟'] },
          { title: ' 风险 ', items: ['依赖波动', '队列延迟'] },
          { title: '', items: ['无效'] },
          { title: '下一步', items: ['继续观察'] },
        ],
      },
    }), '```'].join('\n'), 'C:/workspace');

    assert.equal(result.payload.analysisView?.metrics.length, 6);
    assert.equal(result.payload.analysisView?.metrics[0].label, 'Bridge');
    assert.equal(result.payload.analysisView?.metrics.some((metric) => metric.value === '重复值'), false);
    assert.equal(result.payload.analysisView?.sections.length, 2);
    assert.deepEqual(result.payload.analysisView?.sections[0].items, ['队列延迟', '依赖波动']);
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
