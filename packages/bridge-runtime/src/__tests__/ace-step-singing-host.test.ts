import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AceStepSingingHost } from '../speech/ace-step-singing-host.js';
import type { ValidatedAudio } from '../speech/media-pipeline.js';
import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';

function createFixture(overrides: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-ace-step-'));
  const values = new Map<string, string>([
    ['CTI_SINGING_ENABLED', 'true'],
    ['CTI_SINGING_API_URL', 'http://127.0.0.1:7865/'],
    ['CTI_SINGING_API_TOKEN', '0123456789abcdef0123456789abcdef'],
    ['CTI_SINGING_BENCHMARK_PASSED', 'true'],
    ['CTI_SINGING_MAX_DURATION_SECONDS', '60'],
    ['CTI_SPEECH_MAX_INPUT_BYTES', '1024'],
    ['CTI_SPEECH_FFPROBE_PATH', process.execPath],
    ...Object.entries(overrides),
  ]);
  const config = loadSpeechRuntimeConfig(values);
  return { root, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function songInput() {
  return {
    prompt: '温暖、克制的中文流行歌',
    lyrics: '[Verse]\n今天开始认真唱歌',
    vocalLanguage: 'zh',
    durationSeconds: 10,
  };
}

function validatedOpus(filePath: string): ValidatedAudio {
  const stat = fs.statSync(filePath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return { path: filePath, format: 'ogg', size: stat.size, sha256, durationMs: 10_000, codec: 'opus', channels: 1 };
}

function successfulFetch(calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/release_task')) {
      return Response.json({ code: 200, data: { task_id: 'task_12345678' } });
    }
    if (url.endsWith('/query_result')) {
      return Response.json({
        code: 200,
        data: [{
          task_id: 'task_12345678',
          status: 1,
          result: JSON.stringify([{ status: 1, file: '/v1/audio?path=managed-song.opus' }]),
        }],
      });
    }
    if (url.includes('/v1/audio?')) {
      return new Response(Buffer.from('OggS-safe-opus-fixture', 'ascii'), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe('ACE-Step singing host', () => {
  it('只允许 127.0.0.1 HTTP、临时令牌和已通过的本机基准', async () => {
    for (const [overrides, code] of [
      [{ CTI_SINGING_API_URL: 'http://localhost:7865/' }, 'singing_api_not_loopback'],
      [{ CTI_SINGING_API_TOKEN: '' }, 'singing_api_token_missing'],
      [{ CTI_SINGING_BENCHMARK_PASSED: 'false' }, 'singing_benchmark_not_verified'],
    ] as const) {
      const fixture = createFixture(overrides);
      try {
        const host = new AceStepSingingHost({
          config: fixture.config, ctiHome: fixture.root, runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        });
        await assert.rejects(host.synthesizeSong(songInput()), (error: unknown) => (
          Boolean(error && typeof error === 'object' && (error as { code?: string }).code === code)
        ));
      } finally {
        fixture.cleanup();
      }
    }
  });

  it('按官方 release/query/audio 流程生成并只释放受管 Opus 产物', async () => {
    const fixture = createFixture();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    try {
      const host = new AceStepSingingHost({
        config: fixture.config,
        ctiHome: fixture.root,
        runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        fetchImpl: successfulFetch(calls),
        pollIntervalMs: 1,
        validateAudioImpl: async ({ filePath }) => validatedOpus(filePath),
      });
      const receipt = await host.synthesizeSong(songInput());
      assert.equal(receipt.protocol, 'cti-singing-synthesis/v1');
      assert.equal(receipt.format, 'opus');
      assert.equal(receipt.validated, true);
      assert.equal(fs.existsSync(receipt.path), true);
      const releaseBody = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
      assert.equal(releaseBody.audio_format, 'opus');
      assert.equal(releaseBody.batch_size, 1);
      assert.equal(releaseBody.lm_backend, 'pt');
      assert.ok(calls.every((call) => call.init?.redirect === 'error'));
      host.releaseSynthesis(receipt);
      assert.equal(fs.existsSync(receipt.path), false);
      assert.throws(() => host.releaseSynthesis(receipt), /释放被拒绝/u);
    } finally {
      fixture.cleanup();
    }
  });

  it('拒绝跨 origin 音频地址，且不会请求该地址', async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/release_task')) return Response.json({ code: 200, data: { task_id: 'task_12345678' } });
      return Response.json({
        code: 200,
        data: [{ task_id: 'task_12345678', status: 1, result: [{ status: 1, file: 'https://example.com/v1/audio' }] }],
      });
    }) as typeof fetch;
    try {
      const host = new AceStepSingingHost({
        config: fixture.config, ctiHome: fixture.root, runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        fetchImpl, pollIntervalMs: 1,
      });
      await assert.rejects(host.synthesizeSong(songInput()), /singing_audio_url_invalid/u);
      assert.equal(calls.length, 2);
    } finally {
      fixture.cleanup();
    }
  });

  it('即使 Content-Length 伪装很小也按流式真实字节上限取消', async () => {
    const fixture = createFixture({ CTI_SPEECH_MAX_INPUT_BYTES: '8' });
    // 配置解析会把现场上限钳制到安全最小值；此处直接缩小测试夹具以覆盖逐块累计逻辑。
    fixture.config.maxInputBytes = 8;
    const baseFetch = successfulFetch([]);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/v1/audio?')) return baseFetch(input, init);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('OggS'));
          controller.enqueue(Buffer.from('-too-large'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-length': '1' } });
    }) as typeof fetch;
    try {
      const host = new AceStepSingingHost({
        config: fixture.config, ctiHome: fixture.root, runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        fetchImpl, pollIntervalMs: 1,
      });
      await assert.rejects(host.synthesizeSong(songInput()), /singing_output_too_large/u);
    } finally {
      fixture.cleanup();
    }
  });

  it('真实探针不是 Ogg Opus 时拒绝并清理失败产物', async () => {
    const fixture = createFixture();
    try {
      const host = new AceStepSingingHost({
        config: fixture.config, ctiHome: fixture.root, runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        fetchImpl: successfulFetch([]), pollIntervalMs: 1,
        validateAudioImpl: async ({ filePath }) => ({ ...validatedOpus(filePath), codec: 'vorbis' }),
      });
      await assert.rejects(host.synthesizeSong(songInput()), /singing_output_not_opus/u);
      const outputRoot = path.join(fixture.root, 'runtime', 'speech', 'singing-output');
      assert.deepEqual(fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot) : [], []);
    } finally {
      fixture.cleanup();
    }
  });

  it('释放前重新核对文件哈希，篡改产物时失败关闭', async () => {
    const fixture = createFixture();
    try {
      const host = new AceStepSingingHost({
        config: fixture.config, ctiHome: fixture.root, runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        fetchImpl: successfulFetch([]), pollIntervalMs: 1,
        validateAudioImpl: async ({ filePath }) => validatedOpus(filePath),
      });
      const receipt = await host.synthesizeSong(songInput());
      fs.appendFileSync(receipt.path, 'tampered', 'utf8');
      assert.throws(() => host.releaseSynthesis(receipt), (error: unknown) => (
        Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'singing_release_hash_mismatch')
      ));
    } finally {
      fixture.cleanup();
    }
  });
});
