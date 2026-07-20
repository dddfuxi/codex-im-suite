import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadArtifactStore() {
  try {
    return await import('../artifacts/artifact-store.js');
  } catch {
    return null;
  }
}

describe('turn artifact store', () => {
  it('imports generated files into the turn store and writes a hashed manifest', async () => {
    const module = await loadArtifactStore();
    assert.ok(module, 'artifact store should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-store-'));
    const source = path.join(root, 'legacy-output', 'preview.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'generated-preview', 'utf8');

    try {
      const store = new module.ArtifactStore({
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
        registeredProjects: [],
      });
      const records = store.registerArtifacts({
        sessionId: 'session/1',
        turnId: 'turn:1',
        files: [{ filePath: source, mediaType: 'image/png' }],
        source: { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'JsonTool:mcp_call' },
      });

      assert.equal(records.length, 1);
      assert.match(records[0].id, /^artifact-[a-f0-9]{24}$/u);
      assert.equal(path.relative(path.join(root, 'artifacts'), records[0].filePath).startsWith('..'), false);
      assert.equal(fs.readFileSync(records[0].filePath, 'utf8'), 'generated-preview');
      assert.match(records[0].sha256, /^[a-f0-9]{64}$/u);

      const manifestPath = path.join(path.dirname(records[0].filePath), '产物清单.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        schema: string;
        sessionId: string;
        turnId: string;
        artifacts: Array<{ id: string; sha256: string; source: { toolUseId?: string } }>;
      };
      assert.equal(manifest.schema, 'codex-im-suite/turn-artifacts/v1');
      assert.equal(manifest.sessionId, 'session/1');
      assert.equal(manifest.turnId, 'turn:1');
      assert.equal(manifest.artifacts[0].id, records[0].id);
      assert.equal(manifest.artifacts[0].source.toolUseId, 'tool-1');
      const humanManifest = fs.readFileSync(path.join(path.dirname(records[0].filePath), '产物清单.md'), 'utf8');
      assert.match(humanManifest, /此文件由 Artifact Store 根据 `产物清单\.json` 自动生成/);
      assert.match(humanManifest, new RegExp(records[0].id));
      assert.match(humanManifest, new RegExp(records[0].sha256));

      const scratch = store.getScratchDirectory({ sessionId: 'session/1', turnId: 'turn:1' });
      assert.equal(fs.existsSync(path.join(scratch, '回合元数据.json')), true);
      const scratchMetadata = fs.readFileSync(path.join(scratch, '回合元数据.md'), 'utf8');
      assert.match(scratchMetadata, /根据 `回合元数据\.json` 自动生成/);
      assert.match(scratchMetadata, /session\/1/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('promotes only a real artifact into an enabled read-write project without overwriting', async () => {
    const module = await loadArtifactStore();
    assert.ok(module, 'artifact store should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-promote-'));
    const projectRoot = path.join(root, 'project');
    const readOnlyRoot = path.join(root, 'readonly');
    const source = path.join(root, 'generated.bin');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(readOnlyRoot, { recursive: true });
    fs.writeFileSync(source, 'artifact-data', 'utf8');

    try {
      const store = new module.ArtifactStore({
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'workspaces'),
        registeredProjects: [{
          id: 'write-project', displayName: 'Write Project', type: 'generic', workspaceRoot: projectRoot,
          accessMode: 'read_write', enabled: true,
        }, {
          id: 'read-project', displayName: 'Read Project', type: 'generic', workspaceRoot: readOnlyRoot,
          accessMode: 'read_only', enabled: true,
        }],
      });
      const [artifact] = store.registerArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', files: [{ filePath: source }],
        source: { kind: 'tool_result', toolUseId: 'tool-1', toolName: 'JsonTool:shell_artifact' },
      });
      const promoted = store.promoteArtifact({
        artifactId: artifact.id,
        targetProjectId: 'write-project',
        targetRelativePath: 'Assets/Generated/result.bin',
        expectedSha256: artifact.sha256,
      });

      assert.equal(promoted.ok, true);
      assert.equal(promoted.targetPath, path.join(projectRoot, 'Assets', 'Generated', 'result.bin'));
      assert.equal(fs.readFileSync(promoted.targetPath, 'utf8'), 'artifact-data');
      const promotionMarkdown = fs.readFileSync(path.join(path.dirname(artifact.filePath), '提升记录.md'), 'utf8');
      assert.match(promotionMarkdown, /此文件由 Artifact Store 根据 `提升记录\.jsonl` 自动生成/);
      assert.match(promotionMarkdown, /write-project/);
      assert.match(promotionMarkdown, /Assets\/Generated\/result\.bin/);
      assert.throws(() => store.promoteArtifact({
        artifactId: artifact.id,
        targetProjectId: 'write-project',
        targetRelativePath: 'Assets/Generated/result.bin',
      }), /artifact_target_exists/u);
      assert.throws(() => store.promoteArtifact({
        artifactId: artifact.id,
        targetProjectId: 'read-project',
        targetRelativePath: 'Assets/result.bin',
      }), /project_read_only/u);
      assert.throws(() => store.promoteArtifact({
        artifactId: 'artifact-ffffffffffffffffffffffff',
        targetProjectId: 'write-project',
        targetRelativePath: 'Assets/missing.bin',
      }), /artifact_not_found/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back the machine manifest when the human-readable projection cannot be updated', async () => {
    const module = await loadArtifactStore();
    assert.ok(module, 'artifact store should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-projection-'));
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first', 'utf8');
    fs.writeFileSync(second, 'second', 'utf8');

    try {
      const store = new module.ArtifactStore({
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'scratch'),
        registeredProjects: [],
      });
      const [artifact] = store.registerArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', files: [{ filePath: first }], source: { kind: 'provider_output' },
      });
      const turnDirectory = path.dirname(artifact.filePath);
      const manifestPath = path.join(turnDirectory, '产物清单.json');
      const markdownPath = path.join(turnDirectory, '产物清单.md');
      const before = fs.readFileSync(manifestPath, 'utf8');
      fs.rmSync(markdownPath);
      fs.mkdirSync(markdownPath);

      assert.throws(() => store.registerArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', files: [{ filePath: second }], source: { kind: 'provider_output' },
      }));
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
      assert.equal(fs.readdirSync(turnDirectory).some((name) => name.endsWith('.tmp')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the promoted project file when the human-readable promotion log cannot be committed', async () => {
    const module = await loadArtifactStore();
    assert.ok(module, 'artifact store should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-promotion-projection-'));
    const projectRoot = path.join(root, 'project');
    const source = path.join(root, 'source.bin');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(source, 'artifact', 'utf8');

    try {
      const store = new module.ArtifactStore({
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'scratch'),
        registeredProjects: [{
          id: 'write-project', displayName: 'Write Project', type: 'generic', workspaceRoot: projectRoot,
          accessMode: 'read_write', enabled: true,
        }],
      });
      const [artifact] = store.registerArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', files: [{ filePath: source }], source: { kind: 'provider_output' },
      });
      fs.mkdirSync(path.join(path.dirname(artifact.filePath), '提升记录.md'));
      const targetPath = path.join(projectRoot, 'Assets', 'Generated', 'result.bin');

      assert.throws(() => store.promoteArtifact({
        artifactId: artifact.id,
        targetProjectId: 'write-project',
        targetRelativePath: 'Assets/Generated/result.bin',
      }));
      assert.equal(fs.existsSync(targetPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects nested denied targets, active turn locks, and manifest paths outside the turn store', async () => {
    const module = await loadArtifactStore();
    assert.ok(module, 'artifact store should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-promotion-guards-'));
    const projectRoot = path.join(root, 'project');
    const deniedRoot = path.join(projectRoot, 'Private');
    const source = path.join(root, 'source.bin');
    fs.mkdirSync(deniedRoot, { recursive: true });
    fs.writeFileSync(source, 'artifact', 'utf8');

    try {
      const store = new module.ArtifactStore({
        artifactRoot: path.join(root, 'artifacts'),
        scratchRoot: path.join(root, 'scratch'),
        registeredProjects: [{
          id: 'write-project', displayName: 'Write Project', type: 'generic', workspaceRoot: projectRoot,
          accessMode: 'read_write', enabled: true,
        }],
        deniedRoots: [deniedRoot],
      });
      const [artifact] = store.registerArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', files: [{ filePath: source }], source: { kind: 'provider_output' },
      });
      const turnDirectory = path.dirname(artifact.filePath);

      assert.throws(() => store.promoteArtifact({
        artifactId: artifact.id,
        targetProjectId: 'write-project',
        targetRelativePath: 'Private/result.bin',
      }), /artifact_target_project_denied/u);

      fs.writeFileSync(path.join(turnDirectory, '.artifact-write.lock'), 'locked', 'utf8');
      assert.throws(() => store.promoteArtifact({
        artifactId: artifact.id,
        targetProjectId: 'write-project',
        targetRelativePath: 'Assets/locked.bin',
      }), /artifact_store_locked/u);
      fs.rmSync(path.join(turnDirectory, '.artifact-write.lock'));

      const manifestPath = path.join(turnDirectory, '产物清单.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.artifacts[0].filePath = source;
      manifest.artifacts[0].relativePath = '../../source.bin';
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      assert.throws(() => store.promoteArtifact({
        artifactId: artifact.id,
        targetProjectId: 'write-project',
        targetRelativePath: 'Assets/tampered.bin',
      }), /artifact_manifest_corrupt/u);
      assert.equal(fs.existsSync(path.join(projectRoot, 'Assets', 'tampered.bin')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the persisted artifact manifest is corrupt', async () => {
    const module = await loadArtifactStore();
    assert.ok(module, 'artifact store should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-corrupt-'));
    const artifactRoot = path.join(root, 'artifacts');
    const source = path.join(root, 'source.txt');
    fs.writeFileSync(source, 'source', 'utf8');

    try {
      const store = new module.ArtifactStore({ artifactRoot, scratchRoot: path.join(root, 'scratch'), registeredProjects: [] });
      const turnDirectory = store.getArtifactDirectory({ sessionId: 'session-1', turnId: 'turn-1' });
      fs.writeFileSync(path.join(turnDirectory, '产物清单.json'), '{broken', 'utf8');
      assert.throws(() => store.registerArtifacts({
        sessionId: 'session-1', turnId: 'turn-1', files: [{ filePath: source }],
        source: { kind: 'provider_output' },
      }), /artifact_manifest_corrupt/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
