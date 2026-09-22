import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeSpeechError } from '../speech/runtime-types.js';
import { SpeechSidecarClient } from '../speech/sidecar-supervisor.js';

test('TTS 使用独立动态时限并返回可审计的合成超时码', async () => {
  let interruption = '';
  const hangingFetch = ((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason || new Error('aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  })) as typeof fetch;
  const client = new SpeechSidecarClient(
    'http://127.0.0.1:45678',
    'test-token',
    1_000,
    hangingFetch,
    async (reason) => { interruption = reason; },
  );

  await assert.rejects(client.synthesize({
    text: '测试动态生成时限',
    outputPath: 'managed-output.wav',
    provider: 'qwen3_tts',
    modelId: 'quality-model',
  }, undefined, 20), (error: unknown) => (
    error instanceof RuntimeSpeechError && error.code === 'tts_synthesis_timeout'
  ));
  assert.equal(interruption, 'timeout');
});
