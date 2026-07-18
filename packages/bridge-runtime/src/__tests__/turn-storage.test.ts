import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RuntimeTurnStorage, stageProviderInputFiles } from '../turn-storage.js';

describe('RuntimeTurnStorage', () => {
  it('stages transient inputs under normalized session and turn directories with a hash manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-'));
    const uploadRoot = path.join(root, 'uploads');
    const artifactRoot = path.join(root, 'artifacts');
    const scratchRoot = path.join(root, 'workspaces');
    const workspace = path.join(root, 'unity-project');
    fs.mkdirSync(workspace, { recursive: true });

    try {
      const storage = new RuntimeTurnStorage({ uploadRoot, artifactRoot, scratchRoot });
      const files = storage.stageInputFiles({
        sessionId: 'session/../../1',
        turnId: 'message:1',
        files: [{
          id: 'image-1',
          name: '../截图 01.png',
          type: 'image/png',
          size: 15,
          data: Buffer.from('transient-image').toString('base64'),
        }],
      });

      assert.equal(files.length, 1);
      assert.equal(path.relative(uploadRoot, files[0].filePath).startsWith('..'), false);
      assert.equal(fs.readFileSync(files[0].filePath, 'utf8'), 'transient-image');
      assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
      assert.equal(fs.existsSync(path.join(workspace, '.codepilot-uploads')), false);

      const turnDirectory = path.dirname(files[0].filePath);
      const manifest = JSON.parse(fs.readFileSync(path.join(turnDirectory, '输入附件清单.json'), 'utf8')) as {
        sessionId: string;
        turnId: string;
        files: Array<{ sha256: string; filePath: string }>;
      };
      assert.equal(manifest.sessionId, 'session/../../1');
      assert.equal(manifest.turnId, 'message:1');
      assert.equal(manifest.files[0].sha256, files[0].sha256);
      assert.equal(manifest.files[0].filePath, files[0].filePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses durable memory inputs and exposes runtime-owned artifact and scratch directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-durable-'));
    const memoryRoot = path.join(root, 'memory');
    const durableFile = path.join(memoryRoot, 'data', 'im', 'sticker.png');
    fs.mkdirSync(path.dirname(durableFile), { recursive: true });
    fs.writeFileSync(durableFile, 'durable');

    try {
      const storage = new RuntimeTurnStorage({
        uploadRoot: path.join(root, 'uploads'),
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
        durableInputRoots: [memoryRoot],
      });
      const files = storage.stageInputFiles({
        sessionId: 'session-1',
        turnId: 'turn-1',
        files: [{
          id: 'sticker-1',
          name: 'sticker.png',
          type: 'image/png',
          size: 7,
          data: Buffer.from('durable').toString('base64'),
          filePath: durableFile,
        }],
      });

      assert.equal(files[0].filePath, durableFile);
      assert.equal(storage.getArtifactDirectory({ sessionId: 'session-1', turnId: 'turn-1' }), path.join(root, 'artifacts', 'session-1', 'turn-1'));
      assert.equal(storage.getScratchDirectory({ sessionId: 'session-1', turnId: 'turn-1' }), path.join(root, 'workspaces', 'session-1', 'turn-1'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets providers reuse the turn-scoped input path instead of creating another runtime-root file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-provider-'));
    try {
      const storage = new RuntimeTurnStorage({
        uploadRoot: path.join(root, 'uploads'),
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
      });
      const first = storage.stageInputFiles({
        sessionId: 'session-1',
        turnId: 'turn-1',
        files: [{
          id: 'image-1',
          name: 'incoming.png',
          type: 'image/png',
          size: 5,
          data: Buffer.from('image').toString('base64'),
        }],
      });

      const providerPaths = stageProviderInputFiles(storage, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        files: [{
          id: 'image-1',
          name: 'incoming.png',
          type: 'image/png',
          size: 5,
          data: Buffer.from('image').toString('base64'),
          filePath: first[0].filePath,
        }],
      });

      assert.deepEqual(providerPaths, [first[0].filePath]);
      assert.equal(fs.readdirSync(path.dirname(first[0].filePath)).filter((name) => name.endsWith('.png')).length, 1);
      assert.equal(fs.readdirSync(path.join(root, 'uploads')).some((name) => name.startsWith('ignis-attachment-')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
