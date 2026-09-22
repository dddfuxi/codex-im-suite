import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function loadInspectorModule() {
  try {
    return await import('../artifact-encoding-inspector.js');
  } catch {
    return null;
  }
}

describe('ArtifactEncodingInspector', () => {
  it('rejects invalid UTF-8 replacement characters and likely ASCII question-mark loss', async () => {
    const module = await loadInspectorModule();
    assert.ok(module, 'artifact encoding inspector module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-encoding-invalid-'));
    const invalidUtf8 = path.join(root, 'invalid.md');
    const replacement = path.join(root, 'replacement.txt');
    const questionLoss = path.join(root, 'question-loss.json');
    fs.writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));
    fs.writeFileSync(replacement, '内容包含 � 替换字符', 'utf8');
    fs.writeFileSync(questionLoss, '{"message":"中文已经变成???"}', 'utf8');

    try {
      const inspector = new module.ArtifactEncodingInspector();
      const result = await inspector.inspectFiles({ files: [invalidUtf8, replacement, questionLoss] });

      assert.equal(result.ok, false);
      assert.deepEqual(result.issues.map((issue: { kind: string }) => issue.kind).sort(), [
        'invalid_utf8',
        'question_mark_loss',
        'replacement_character',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts normal UTF-8 text single or double questions regexes URLs and binary files', async () => {
    const module = await loadInspectorModule();
    assert.ok(module, 'artifact encoding inspector module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-encoding-valid-'));
    const markdown = path.join(root, '说明.md');
    const script = path.join(root, 'check.ps1');
    const binary = path.join(root, 'preview.png');
    fs.writeFileSync(markdown, '中文正常？\n单问号 ? 双问号 ??\nhttps://example.com/?a=1&b=2', 'utf8');
    fs.writeFileSync(script, "if ($value -match '^(?:\\d+)(?:\\.0+)?$') { '正常' }", 'utf8');
    fs.writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

    try {
      const inspector = new module.ArtifactEncodingInspector();
      const result = await inspector.inspectFiles({ files: [markdown, script, binary] });
      assert.deepEqual(result, { ok: true, issues: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('inspects text inside ZIP files without treating binary entries as text', async () => {
    const module = await loadInspectorModule();
    assert.ok(module, 'artifact encoding inspector module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-encoding-zip-'));
    const damagedZip = path.join(root, 'damaged.zip');
    const validZip = path.join(root, 'valid.zip');
    fs.writeFileSync(damagedZip, buildStoredZip([
      { name: 'docs/说明.md', data: Buffer.from('这里已经变成???', 'utf8') },
      { name: 'images/preview.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]) },
    ]));
    fs.writeFileSync(validZip, buildStoredZip([
      { name: 'docs/说明.md', data: Buffer.from('中文内容正常', 'utf8') },
      { name: 'images/preview.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]) },
    ]));

    try {
      const inspector = new module.ArtifactEncodingInspector();
      const damaged = await inspector.inspectFiles({ files: [damagedZip] });
      assert.equal(damaged.ok, false);
      assert.equal(damaged.issues[0]?.kind, 'question_mark_loss');
      assert.equal(damaged.issues[0]?.entryName, 'docs/说明.md');
      assert.deepEqual(await inspector.inspectFiles({ files: [validZip] }), { ok: true, issues: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for ZIP traversal names entry-count limits and oversized text entries', async () => {
    const module = await loadInspectorModule();
    assert.ok(module, 'artifact encoding inspector module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-encoding-zip-guards-'));
    const traversalZip = path.join(root, 'traversal.zip');
    const tooManyZip = path.join(root, 'too-many.zip');
    const oversizedZip = path.join(root, 'oversized.zip');
    fs.writeFileSync(traversalZip, buildStoredZip([{ name: '../escape.md', data: Buffer.from('正常', 'utf8') }]));
    fs.writeFileSync(tooManyZip, buildStoredZip(Array.from({ length: 257 }, (_, index) => ({
      name: `docs/${index}.txt`,
      data: Buffer.from('ok', 'utf8'),
    }))));
    fs.writeFileSync(oversizedZip, buildStoredZip([{
      name: 'docs/huge.md',
      data: Buffer.alloc((2 * 1024 * 1024) + 1, 0x61),
    }]));

    try {
      const inspector = new module.ArtifactEncodingInspector();
      assert.equal((await inspector.inspectFiles({ files: [traversalZip] })).issues[0]?.kind, 'unsafe_zip_entry');
      assert.equal((await inspector.inspectFiles({ files: [tooManyZip] })).issues[0]?.kind, 'zip_limit');
      assert.equal((await inspector.inspectFiles({ files: [oversizedZip] })).issues[0]?.kind, 'zip_limit');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is exposed through the Core host boundary and injected by the Runtime entry point', () => {
    const suiteRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const host = fs.readFileSync(path.join(suiteRoot, 'bridge-core', 'src', 'lib', 'bridge', 'host.ts'), 'utf8');
    const context = fs.readFileSync(path.join(suiteRoot, 'bridge-core', 'src', 'lib', 'bridge', 'context.ts'), 'utf8');
    const main = fs.readFileSync(path.join(suiteRoot, 'bridge-runtime', 'src', 'main.ts'), 'utf8');

    assert.match(host, /interface ArtifactEncodingInspectorHost/u);
    assert.match(context, /artifactEncoding\?: ArtifactEncodingInspectorHost/u);
    assert.match(main, /new ArtifactEncodingInspector\(\)/u);
    assert.match(main, /artifactEncoding/u);
  });
});
