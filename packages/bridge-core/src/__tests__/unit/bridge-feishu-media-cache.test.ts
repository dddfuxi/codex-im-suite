import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../../lib/bridge/channels/feishu/media/sticker-media-cache.js');
  } catch {
    return null;
  }
}

describe('Feishu sticker media cache', () => {
  it('uses file headers for the durable extension and reuses the first cached copy', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu sticker media cache module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-media-cache-'));

    try {
      const cache = new module.FeishuStickerMediaCache(root, { maxFileSize: 1024 });
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const first = cache.persist('file/key:1', {
        id: 'download-1',
        name: 'wrong.jpg',
        type: 'image/jpeg',
        size: png.length,
        data: png.toString('base64'),
      });

      assert.ok(first);
      assert.equal(first.mimeType, 'image/png');
      assert.match(first.attachment.filePath || '', /\.png$/u);
      assert.deepEqual(fs.readFileSync(first.attachment.filePath!), png);

      const replacement = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
      const second = cache.persist('file/key:1', {
        id: 'download-2',
        name: 'replacement.jpg',
        type: 'image/jpeg',
        size: replacement.length,
        data: replacement.toString('base64'),
      });
      assert.ok(second);
      assert.equal(second.attachment.filePath, first.attachment.filePath);
      assert.deepEqual(fs.readFileSync(first.attachment.filePath!), png);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads compatible legacy extensions but rejects empty, oversized, or non-image writes', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu sticker media cache module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-media-legacy-'));

    try {
      const cache = new module.FeishuStickerMediaCache(root, { maxFileSize: 8 });
      const legacyPath = cache.pathFor('legacy-key', '.jpeg');
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

      const legacy = cache.read('legacy-key');
      assert.ok(legacy);
      assert.equal(legacy.type, 'image/jpeg');
      assert.match(legacy.name, /\.jpg$/u);
      assert.equal(cache.persist('empty', { id: '1', name: 'empty.png', type: 'image/png', size: 0, data: '' }), null);
      assert.equal(cache.persist('large', { id: '2', name: 'large.png', type: 'image/png', size: 9, data: Buffer.alloc(9).toString('base64') }), null);
      assert.equal(cache.persist('text', { id: '3', name: 'text.txt', type: 'text/plain', size: 4, data: Buffer.from('text').toString('base64') }), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
