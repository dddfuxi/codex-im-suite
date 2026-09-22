import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FeishuAdapter } from './feishu-adapter.js';

test('飞书语音 reply/create 两路固定上传 opus 并发送 audio', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-audio-'));
  const audioPath = path.join(tempDir, 'reply.opus');
  fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)]));
  const audioSha256 = crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
  const uploads: Array<Record<string, unknown>> = [];
  const replies: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];
  const adapter = new FeishuAdapter();
  (adapter as unknown as { restClient: unknown }).restClient = {
    im: {
      file: {
        create: async (input: { data: Record<string, unknown> }) => {
          uploads.push(input.data);
          const stream = input.data.file as fs.ReadStream;
          stream.resume();
          await new Promise<void>((resolve, reject) => {
            stream.once('end', resolve);
            stream.once('error', reject);
          });
          return { file_key: `file-${uploads.length}` };
        },
      },
      message: {
        reply: async (input: Record<string, unknown>) => {
          replies.push(input);
          return { data: { message_id: 'audio-reply-message' } };
        },
        create: async (input: Record<string, unknown>) => {
          creates.push(input);
          return { data: { message_id: 'audio-create-message' } };
        },
      },
    },
  };

  try {
    assert.deepEqual(await adapter.sendLocalAudio(
      'chat-1', audioPath, 'source-message', { expectedSha256: audioSha256 },
    ), {
      ok: true,
      messageId: 'audio-reply-message',
    });
    assert.deepEqual(await adapter.sendLocalAudio(
      'chat-1', audioPath, undefined, { expectedSha256: audioSha256 },
    ), {
      ok: true,
      messageId: 'audio-create-message',
    });
    assert.equal(uploads.length, 2);
    for (const upload of uploads) {
      assert.equal(upload.file_type, 'opus');
      assert.equal(upload.file_name, 'reply.opus');
    }
    assert.deepEqual((replies[0].data as Record<string, unknown>).msg_type, 'audio');
    assert.deepEqual((creates[0].data as Record<string, unknown>).msg_type, 'audio');
    assert.match(String((replies[0].data as Record<string, unknown>).content), /file-1/u);
    assert.match(String((creates[0].data as Record<string, unknown>).content), /file-2/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('飞书语音发送在上传前拒绝与 Runtime 回执不一致的文件哈希', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-audio-hash-'));
  const audioPath = path.join(tempDir, 'reply.opus');
  fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 2)]));
  let uploadCalls = 0;
  const adapter = new FeishuAdapter();
  (adapter as unknown as { restClient: unknown }).restClient = {
    im: {
      file: { create: async () => { uploadCalls += 1; return { file_key: 'unexpected' }; } },
    },
  };

  try {
    const result = await adapter.sendLocalAudio(
      'chat-1', audioPath, undefined, { expectedSha256: '0'.repeat(64) },
    );
    assert.equal(result.ok, false);
    assert.match(result.error || '', /SHA-256/u);
    assert.equal(uploadCalls, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('飞书语音发送拒绝空文件、伪装格式和符号链接', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-audio-invalid-'));
  const emptyPath = path.join(tempDir, 'empty.opus');
  const fakePath = path.join(tempDir, 'fake.opus');
  fs.writeFileSync(emptyPath, Buffer.alloc(0));
  fs.writeFileSync(fakePath, Buffer.from('RIFF-not-opus'));
  const adapter = new FeishuAdapter();
  (adapter as unknown as { restClient: unknown }).restClient = { im: {} };
  try {
    assert.equal((await adapter.sendLocalAudio('chat-1', emptyPath)).ok, false);
    assert.equal((await adapter.sendLocalAudio('chat-1', fakePath)).ok, false);
    if (process.platform === 'win32') return;
    const linkPath = path.join(tempDir, 'link.opus');
    fs.symlinkSync(fakePath, linkPath);
    assert.equal((await adapter.sendLocalAudio('chat-1', linkPath)).ok, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
