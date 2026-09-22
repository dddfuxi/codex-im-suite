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
    ['CTI_SPEECH_FFMPEG_PATH', process.execPath],
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

function validatedAudio(filePath: string): ValidatedAudio {
  const stat = fs.statSync(filePath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return path.extname(filePath) === '.wav'
    ? { path: filePath, format: 'wav', size: stat.size, sha256, durationMs: 10_000, codec: 'pcm_s16le', channels: 2 }
    : { path: filePath, format: 'ogg', size: stat.size, sha256, durationMs: 10_000, codec: 'opus', channels: 1 };
}

async function transcodeFixture(input: { outputPath: string }): Promise<void> {
  fs.writeFileSync(input.outputPath, Buffer.from('OggS-safe-opus-fixture', 'ascii'), { flag: 'wx' });
}

async function acceptedSongOutput(input: { referenceAudioPath?: string }) {
  return {
    lyrics: { score: 0.96, threshold: 0.8, passed: true },
    ...(input.referenceAudioPath
      ? {
          speakerSimilarityStatus: 'passed' as const,
          speakerSimilarity: 0.88,
          speakerSimilarityThreshold: 0.72,
          speakerSimilarityPassed: true as const,
        }
      : { speakerSimilarityStatus: 'not_applicable' as const }),
  };
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
          result: JSON.stringify([{ status: 1, file: '/v1/audio?path=managed-song.wav' }]),
        }],
      });
    }
    if (url.includes('/v1/audio?')) {
      return new Response(Buffer.from('RIFF-safeWAVE-fixture', 'ascii'), { status: 200 });
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

  it('明确要求克隆音色演唱时必须存在已激活参考歌声音色', async () => {
    const fixture = createFixture();
    try {
      const host = new AceStepSingingHost({
        config: fixture.config,
        ctiHome: fixture.root,
        runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        fetchImpl: (async () => { throw new Error('fetch_should_not_run'); }) as typeof fetch,
      });
      await assert.rejects(
        host.synthesizeSong({ ...songInput(), voiceRequirement: 'active_reference' }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'singing_reference_voice_not_active'),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('受管 benchmark 被取消时终止 ACE Runtime，避免服务端继续占用本机资源', async () => {
    const fixture = createFixture({ CTI_SINGING_API_URL: '', CTI_SINGING_API_TOKEN: '' });
    const controller = new AbortController();
    let stops = 0;
    try {
      const host = new AceStepSingingHost({
        config: fixture.config,
        ctiHome: fixture.root,
        runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        managedRuntime: {
          ensureRunning: async () => ({
            baseUrl: 'http://127.0.0.1:7865/',
            token: '0123456789abcdef0123456789abcdef',
            temporaryAudioRoot: os.tmpdir(),
          }),
          stop: () => { stops += 1; },
        },
        fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })) as typeof fetch,
      });
      const pending = host.synthesizeSong({ ...songInput(), benchmarkMode: true, signal: controller.signal });
      setImmediate(() => controller.abort(new Error('benchmark_expired')));
      await assert.rejects(pending);
      assert.equal(stops, 1);
    } finally {
      fixture.cleanup();
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
        validateAudioImpl: async ({ filePath }) => validatedAudio(filePath),
        wavToMonoOpusImpl: transcodeFixture,
        verifyOutput: acceptedSongOutput,
      });
      const receipt = await host.synthesizeSong(songInput());
      assert.equal(receipt.protocol, 'cti-singing-synthesis/v1');
      assert.equal(receipt.format, 'opus');
      assert.equal(receipt.validated, true);
      assert.equal(fs.existsSync(receipt.path), true);
      const releaseBody = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
      assert.equal(releaseBody.audio_format, 'wav');
      assert.equal(releaseBody.batch_size, 1);
      assert.equal(releaseBody.thinking, true);
      assert.equal(releaseBody.use_cot_caption, false);
      assert.equal(releaseBody.use_cot_language, false);
      assert.equal('lm_model_path' in releaseBody, false);
      assert.equal('lm_backend' in releaseBody, false);
      assert.equal(releaseBody.prompt, songInput().prompt);
      assert.equal(releaseBody.lyrics, songInput().lyrics);
      assert.equal(releaseBody.instrumental, false);
      assert.match(String(releaseBody.instruction), /Start singing immediately/u);
      assert.match(String(releaseBody.instruction), /every supplied zh lyric/u);
      assert.ok(calls.every((call) => call.init?.redirect === 'error'));
      assert.deepEqual(fs.readdirSync(path.dirname(receipt.path)).filter((name) => name.endsWith('.wav')), []);
      host.releaseSynthesis(receipt);
      assert.equal(fs.existsSync(receipt.path), false);
      assert.throws(() => host.releaseSynthesis(receipt), /释放被拒绝/u);
    } finally {
      fixture.cleanup();
    }
  });

  it('克隆歌声仅将经哈希核验的临时参考副本交给 ACE-Step，并在完成后清理', async () => {
    const fixture = createFixture({ CTI_SINGING_API_URL: '', CTI_SINGING_API_TOKEN: '' });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sourcePath = path.join(fixture.root, 'authorized-reference.wav');
    const managedTempRoot = path.join(fixture.root, 'managed-ace-temp');
    fs.mkdirSync(managedTempRoot);
    fs.writeFileSync(sourcePath, Buffer.from('authorized reference audio', 'utf8'));
    fixture.config.singingVoiceProfileId = 'reference.voice';
    try {
      const host = new AceStepSingingHost({
        config: fixture.config,
        ctiHome: fixture.root,
        runtimeDepsRoot: path.join(fixture.root, 'runtime-deps'),
        voiceRegistry: {
          resolveProfile: () => ({ kind: 'reference', path: sourcePath }),
        } as any,
        managedRuntime: {
          ensureRunning: async () => ({
            baseUrl: 'http://127.0.0.1:7865/',
            token: '0123456789abcdef0123456789abcdef',
            temporaryAudioRoot: managedTempRoot,
          }),
        },
        fetchImpl: successfulFetch(calls),
        pollIntervalMs: 1,
        normalizeReferenceAudioImpl: async ({ sourcePath, outputPath }) => {
          fs.copyFileSync(sourcePath, outputPath, fs.constants.COPYFILE_EXCL);
        },
        validateAudioImpl: async ({ filePath }) => validatedAudio(filePath),
        wavToMonoOpusImpl: transcodeFixture,
        verifyOutput: acceptedSongOutput,
      });
      const receipt = await host.synthesizeSong({ ...songInput(), voiceRequirement: 'active_reference' });
      const releaseBody = JSON.parse(String(calls[0].init?.body)) as { reference_audio_path?: string };
      const apiReferencePath = releaseBody.reference_audio_path || '';
      assert.notEqual(apiReferencePath, sourcePath);
      assert.ok(apiReferencePath.startsWith(path.resolve(managedTempRoot)));
      assert.equal(fs.existsSync(apiReferencePath), false);
      assert.equal(fs.existsSync(sourcePath), true);
      host.releaseSynthesis(receipt);
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
          controller.enqueue(Buffer.alloc(6 * 1024 * 1024, 0x61));
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
        validateAudioImpl: async ({ filePath }) => ({
          ...validatedAudio(filePath),
          ...(path.extname(filePath) === '.ogg' ? { codec: 'vorbis' } : {}),
        }),
        wavToMonoOpusImpl: transcodeFixture,
        verifyOutput: acceptedSongOutput,
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
        validateAudioImpl: async ({ filePath }) => validatedAudio(filePath),
        wavToMonoOpusImpl: transcodeFixture,
        verifyOutput: acceptedSongOutput,
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
