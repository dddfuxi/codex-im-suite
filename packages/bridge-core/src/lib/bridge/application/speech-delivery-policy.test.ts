import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_POLICY_REGISTRY } from '../agent-architecture.js';
import {
  extractFinalReplyEnvelope,
  prepareDeliveryCandidate,
} from './delivery-preparation.js';

test('cti-final 只清洗 voice_only 语音呈现意图', () => {
  const source = [
    '```cti-final',
    JSON.stringify({
      kind: 'text',
      text: '这是最终可见正文。',
      images: [],
      files: [],
      reply_mode: 'markdown',
      speech: {
        mode: 'voice_only',
        provider: 'forged-provider',
        path: 'C:\\forged\\reply.opus',
        voiceProfileId: 'forged-voice',
        file_key: 'forged-file-key',
      },
    }),
    '```',
  ].join('\n');
  assert.equal(extractFinalReplyEnvelope(source)?.speech, undefined);
  const prepared = prepareDeliveryCandidate(source, 'C:\\workspace');
  assert.equal(prepared.payload.speech, undefined);
});

test('未知 speech mode 或字符串值不会触发语音交付', () => {
  const build = (speech: unknown) => [
    '```cti-final',
    JSON.stringify({ kind: 'text', text: '正文', images: [], files: [], reply_mode: 'plain', speech }),
    '```',
  ].join('\n');
  assert.equal(extractFinalReplyEnvelope(build({ mode: 'voice_and_text' }))?.speech, undefined);
  assert.equal(extractFinalReplyEnvelope(build('voice_only'))?.speech, undefined);
});

test('语音呈现边界登记在 Delivery Layer，而不是写死到 Feishu adapter prompt', () => {
  const policy = AGENT_POLICY_REGISTRY.find((item) => item.id === 'delivery_layer.speech_reply');
  assert.equal(policy?.layerId, 'delivery_layer');
  assert.match(policy?.promptLines.join('\n') || '', /speech\.mode=voice_only/u);
  assert.match(policy?.promptLines.join('\n') || '', /provider|path|voice/u);
});
