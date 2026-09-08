import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimateSpeechDurationMs,
  resolveSpeechSynthesisTimeoutMs,
} from '../speech/speech-synthesis-timeout-policy.js';

test('高质量慢模型按同身份 benchmark 放宽合成时限，不再复用 90 秒媒体请求时限', () => {
  const timeoutMs = resolveSpeechSynthesisTimeoutMs({
    text: '嘘……现在是凌晨两点。停尸房里，忽然响起一阵手机铃声。值班医生只看了一眼，脸色瞬间惨白。',
    requestTimeoutMs: 90_000,
    synthesisTimeoutMs: 600_000,
    startupTimeoutMs: 20_000,
    benchmark: {
      warmSynthesisMs: 86_707,
      outputDurationMs: 16_567,
      realTimeFactor: 5.2337,
    },
  });

  assert.ok(timeoutMs > 90_000, `expected adaptive timeout above legacy limit, got ${timeoutMs}`);
  assert.ok(timeoutMs <= 600_000);
});

test('首次运行缺少 benchmark 时使用受控合成上限，避免冷启动被误判为失败', () => {
  assert.equal(resolveSpeechSynthesisTimeoutMs({
    text: '首次生成也需要完整等待模型就绪。',
    requestTimeoutMs: 90_000,
    synthesisTimeoutMs: 420_000,
    startupTimeoutMs: 20_000,
    benchmark: null,
  }), 420_000);
});

test('自适应计算始终服从合成绝对上限并支持中英文文本时长估算', () => {
  assert.ok(estimateSpeechDurationMs('这是中文。') > 1_000);
  assert.ok(estimateSpeechDurationMs('This is an English sentence.') > 1_000);
  assert.equal(resolveSpeechSynthesisTimeoutMs({
    text: '很长的内容。'.repeat(500),
    requestTimeoutMs: 90_000,
    synthesisTimeoutMs: 180_000,
    startupTimeoutMs: 20_000,
    benchmark: { realTimeFactor: 10 },
  }), 180_000);
});
