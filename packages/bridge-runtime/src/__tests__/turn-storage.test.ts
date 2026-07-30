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
      const humanManifest = fs.readFileSync(path.join(turnDirectory, '输入附件清单.md'), 'utf8');
      assert.match(humanManifest, /根据 `输入附件清单\.json` 自动生成/);
      assert.match(humanManifest, /截图 01\.png/);
      assert.match(humanManifest, new RegExp(files[0].sha256));
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

  it('removes newly staged inputs when the human-readable manifest cannot be committed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-projection-'));
    try {
      const storage = new RuntimeTurnStorage({
        uploadRoot: path.join(root, 'uploads'),
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
      });
      const turnDirectory = path.join(root, 'uploads', 'session-1', 'turn-1');
      fs.mkdirSync(path.join(turnDirectory, '输入附件清单.md'), { recursive: true });

      assert.throws(() => storage.stageInputFiles({
        sessionId: 'session-1',
        turnId: 'turn-1',
        files: [{
          id: 'image-1', name: 'incoming.png', type: 'image/png', size: 5,
          data: Buffer.from('image').toString('base64'),
        }],
      }));
      assert.equal(fs.readdirSync(turnDirectory).some((name) => name.endsWith('.png')), false);
      assert.equal(fs.existsSync(path.join(turnDirectory, '输入附件清单.json')), false);
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

  it('registers tool-result artifacts with stable ids and promotes them through the structured host boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-artifact-host-'));
    const projectRoot = path.join(root, 'project');
    const generated = path.join(root, 'legacy-output.png');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(generated, 'generated');

    try {
      const storage = new RuntimeTurnStorage({
        uploadRoot: path.join(root, 'uploads'),
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
        registeredProjects: [{
          id: 'project-1', displayName: 'Project 1', type: 'generic', workspaceRoot: projectRoot,
          accessMode: 'read_write', enabled: true,
        }],
      });
      const artifacts = storage.registerToolResultArtifacts({
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-1',
        toolName: 'JsonTool:mcp_call',
        content: JSON.stringify({
          tool: 'mcp_call',
          ok: true,
          data: { artifacts: { images: [generated] } },
        }),
        isError: false,
      });

      assert.equal(artifacts.length, 1);
      assert.match(artifacts[0].id, /^artifact-[a-f0-9]{24}$/u);
      assert.equal(path.relative(path.join(root, 'artifacts'), artifacts[0].filePath).startsWith('..'), false);
      const result = storage.promoteArtifact({
        artifactId: artifacts[0].id,
        targetProjectId: 'project-1',
        targetRelativePath: 'Assets/Generated/output.png',
        expectedSha256: artifacts[0].sha256,
      });
      assert.equal(fs.readFileSync(result.targetPath, 'utf8'), 'generated');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not register arbitrary read-tool paths as generated artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-artifact-filter-'));
    const source = path.join(root, 'README.md');
    fs.writeFileSync(source, '# read only');
    try {
      const storage = new RuntimeTurnStorage({
        uploadRoot: path.join(root, 'uploads'),
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
      });
      const artifacts = storage.registerToolResultArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1', toolName: 'Read',
        content: JSON.stringify({ path: source, content: '# read only' }), isError: false,
      });
      assert.deepEqual(artifacts, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('verifies a fresh final artifact from a successful CLI wrapper inside the allowed workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-final-artifact-'));
    const workspace = path.join(root, 'workspace');
    const generated = path.join(workspace, 'captures', 'current.png');
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    const createdAfter = new Date(Date.now() - 500).toISOString();
    fs.writeFileSync(generated, 'generated');
    try {
      const storage = new RuntimeTurnStorage({
        uploadRoot: path.join(root, 'uploads'), artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
      });
      const artifacts = storage.verifyDeclaredOutputArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', createdAfter, allowedRoots: [workspace],
        declaredFiles: [{ filePath: generated }],
        successfulToolResults: [{
          toolUseId: 'tool-1', toolName: 'shell_command',
          content: `Exit code: 0\nWall time: 0.6 seconds\nOutput:\n${JSON.stringify({ Path: generated, Width: 1935 })}`,
        }],
      });
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].source.toolName, 'shell_command');
      assert.equal(path.relative(path.join(root, 'artifacts'), artifacts[0].filePath).startsWith('..'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing, stale, model-only, and outside-root final artifact declarations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-turn-storage-final-artifact-reject-'));
    const workspace = path.join(root, 'workspace');
    const stale = path.join(workspace, 'stale.png');
    const modelOnly = path.join(workspace, 'model-only.png');
    const outside = path.join(root, 'outside.png');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(stale, 'stale');
    fs.writeFileSync(modelOnly, 'model-only');
    fs.writeFileSync(outside, 'outside');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, oldTime, oldTime);
    try {
      const storage = new RuntimeTurnStorage({
        uploadRoot: path.join(root, 'uploads'), artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
      });
      const common = {
        sessionId: 'session-1', turnId: 'turn-1', allowedRoots: [workspace],
        createdAfter: new Date(Date.now() - 1_000).toISOString(),
      };
      assert.deepEqual(storage.verifyDeclaredOutputArtifacts({
        ...common,
        declaredFiles: [{ filePath: path.join(workspace, 'missing.png') }],
        successfulToolResults: [{ toolUseId: 'tool-1', toolName: 'shell_command', content: JSON.stringify({ Path: path.join(workspace, 'missing.png') }) }],
      }), []);
      assert.deepEqual(storage.verifyDeclaredOutputArtifacts({
        ...common,
        declaredFiles: [{ filePath: stale }],
        successfulToolResults: [{ toolUseId: 'tool-1', toolName: 'shell_command', content: JSON.stringify({ Path: stale }) }],
      }), []);
      assert.deepEqual(storage.verifyDeclaredOutputArtifacts({
        ...common,
        declaredFiles: [{ filePath: modelOnly }],
        successfulToolResults: [{ toolUseId: 'tool-1', toolName: 'shell_command', content: JSON.stringify({ ok: true }) }],
      }), []);
      assert.deepEqual(storage.verifyDeclaredOutputArtifacts({
        ...common,
        declaredFiles: [{ filePath: outside }],
        successfulToolResults: [{ toolUseId: 'tool-1', toolName: 'shell_command', content: JSON.stringify({ Path: outside }) }],
      }), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
