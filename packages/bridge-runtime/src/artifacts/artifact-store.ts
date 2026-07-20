import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseArtifactPromotionRequest,
  type ArtifactPromotionRequest,
  type ArtifactPromotionResult,
  type ArtifactSource,
  type RegisteredProject,
  type TurnArtifactManifestV1,
  type TurnArtifactRecord,
} from '@codex-im-suite/contracts';
import {
  ensureTurnDirectory,
  resolveTurnDirectory,
  writeAtomicProjection,
  type TurnScope,
} from './session-scratch.js';

export interface ArtifactStoreOptions {
  artifactRoot: string;
  scratchRoot: string;
  registeredProjects: readonly RegisteredProject[];
  deniedRoots?: readonly string[];
}

export interface RegisterArtifactsInput extends TurnScope {
  files: Array<{ filePath: string; mediaType?: string }>;
  source: ArtifactSource;
}

const MANIFEST_NAME = '产物清单.json';
const MANIFEST_MARKDOWN_NAME = '产物清单.md';
const PROMOTION_LEDGER_NAME = '提升记录.jsonl';
const PROMOTION_MARKDOWN_NAME = '提升记录.md';

function commitMachineAndHumanProjection(input: {
  machinePath: string;
  machineContent: string;
  humanPath: string;
  humanContent: string;
}): void {
  writeAtomicProjection(input);
}

function escapeMarkdownCell(value: unknown): string {
  return String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function renderArtifactManifestMarkdown(manifest: TurnArtifactManifestV1): string {
  const lines = [
    '# 回合产物清单',
    '',
    '> 此文件由 Artifact Store 根据 `产物清单.json` 自动生成；请勿手工修改。',
    '',
    `- 会话：${manifest.sessionId}`,
    `- 回合：${manifest.turnId}`,
    `- 更新时间：${manifest.generatedAt}`,
    '',
    '| 产物 ID | 文件 | 相对路径 | 大小（字节） | SHA-256 | 来源 |',
    '|---|---|---|---:|---|---|',
  ];
  for (const artifact of manifest.artifacts) {
    const source = [artifact.source.kind, artifact.source.toolName, artifact.source.toolUseId].filter(Boolean).join(' / ');
    lines.push(`| ${escapeMarkdownCell(artifact.id)} | ${escapeMarkdownCell(artifact.fileName)} | ${escapeMarkdownCell(artifact.relativePath)} | ${artifact.sizeBytes} | ${artifact.sha256} | ${escapeMarkdownCell(source)} |`);
  }
  if (manifest.artifacts.length === 0) lines.push('| 暂无 |  |  | 0 |  |  |');
  return `${lines.join('\n')}\n`;
}

function parsePromotionLedger(content: string): ArtifactPromotionResult[] {
  return content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parsed = JSON.parse(line) as ArtifactPromotionResult;
    if (parsed.ok !== true || !parsed.artifactId || !parsed.targetProjectId || !parsed.targetPath) {
      throw new Error('artifact_promotion_ledger_corrupt');
    }
    return parsed;
  });
}

function renderPromotionMarkdown(records: ArtifactPromotionResult[]): string {
  const lines = [
    '# 产物提升记录',
    '',
    '> 此文件由 Artifact Store 根据 `提升记录.jsonl` 自动生成；请勿手工修改。',
    '',
    '| 时间 | 产物 ID | 目标项目 | 目标路径 | SHA-256 |',
    '|---|---|---|---|---|',
  ];
  for (const record of records) {
    lines.push(`| ${record.promotedAt} | ${record.artifactId} | ${record.targetProjectId} | ${escapeMarkdownCell(record.targetPath.replace(/\\/gu, '/'))} | ${record.sha256} |`);
  }
  if (records.length === 0) lines.push('| 暂无 |  |  |  |  |');
  return `${lines.join('\n')}\n`;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeFileName(filePath: string): string {
  const base = path.basename(filePath).normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_{2,}/gu, '_')
    .replace(/^\.+|\.+$/gu, '')
    .slice(0, 120);
  return base || 'artifact.bin';
}

function inferMediaType(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.json': 'application/json', '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown',
  } as Record<string, string>)[extension];
}

function readManifest(manifestPath: string, scope: TurnScope): TurnArtifactManifestV1 {
  if (!fs.existsSync(manifestPath)) {
    return {
      schema: 'codex-im-suite/turn-artifacts/v1',
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      generatedAt: new Date().toISOString(),
      artifacts: [],
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TurnArtifactManifestV1;
    if (
      parsed.schema !== 'codex-im-suite/turn-artifacts/v1'
      || parsed.sessionId !== scope.sessionId
      || parsed.turnId !== scope.turnId
      || !Array.isArray(parsed.artifacts)
    ) throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error('artifact_manifest_corrupt');
  }
}

function withManifestLock<T>(turnDirectory: string, action: () => T): T {
  const lockPath = path.join(turnDirectory, '.artifact-write.lock');
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, 'wx');
  } catch {
    throw new Error('artifact_store_locked');
  }
  try {
    return action();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* lock cleanup is best effort */ }
  }
}

function makeArtifactId(scope: TurnScope, relativePath: string, digest: string): string {
  const value = `${scope.sessionId}\0${scope.turnId}\0${relativePath}\0${digest}`;
  return `artifact-${crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)}`;
}

function assertNoSymlinkPath(root: string, targetParent: string): void {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(targetParent));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('artifact_target_outside_project');
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('artifact_target_symlink_denied');
  }
}

export class ArtifactStore {
  readonly artifactRoot: string;
  readonly scratchRoot: string;
  private readonly registeredProjects: readonly RegisteredProject[];
  private readonly deniedRoots: readonly string[];

  constructor(options: ArtifactStoreOptions) {
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.scratchRoot = path.resolve(options.scratchRoot);
    this.registeredProjects = options.registeredProjects;
    this.deniedRoots = (options.deniedRoots || []).map((item) => path.resolve(item));
  }

  getArtifactDirectory(scope: TurnScope): string {
    return ensureTurnDirectory(this.artifactRoot, scope, 'artifact');
  }

  getScratchDirectory(scope: TurnScope): string {
    return ensureTurnDirectory(this.scratchRoot, scope, 'scratch');
  }

  registerArtifacts(input: RegisterArtifactsInput): TurnArtifactRecord[] {
    const turnDirectory = this.getArtifactDirectory(input);
    return withManifestLock(turnDirectory, () => {
      const manifestPath = path.join(turnDirectory, MANIFEST_NAME);
      const markdownPath = path.join(turnDirectory, MANIFEST_MARKDOWN_NAME);
      const manifest = readManifest(manifestPath, input);
      const records: TurnArtifactRecord[] = [];
      const createdManagedPaths: string[] = [];
      try {
        for (const file of input.files) {
          const sourcePath = path.resolve(file.filePath);
          if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile() || fs.lstatSync(sourcePath).isSymbolicLink()) {
            throw new Error('artifact_source_invalid');
          }
          const digest = sha256File(sourcePath);
          let managedPath = sourcePath;
          if (!isPathInside(turnDirectory, sourcePath)) {
            managedPath = path.join(turnDirectory, `${digest.slice(0, 12)}-${safeFileName(sourcePath)}`);
            if (!fs.existsSync(managedPath)) {
              const temporaryPath = `${managedPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
              try {
                fs.copyFileSync(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
                fs.renameSync(temporaryPath, managedPath);
                createdManagedPaths.push(managedPath);
              } finally {
                if (fs.existsSync(temporaryPath)) {
                  try { fs.unlinkSync(temporaryPath); } catch { /* 原始错误优先 */ }
                }
              }
            } else if (sha256File(managedPath) !== digest) {
              throw new Error('artifact_target_collision');
            }
          } else {
            assertNoSymlinkPath(turnDirectory, path.dirname(sourcePath));
          }
          const relativePath = path.relative(turnDirectory, managedPath).replace(/\\/gu, '/');
          const record: TurnArtifactRecord = {
            id: makeArtifactId(input, relativePath, digest),
            sessionId: input.sessionId,
            turnId: input.turnId,
            fileName: path.basename(managedPath),
            relativePath,
            filePath: managedPath,
            ...(file.mediaType || inferMediaType(managedPath) ? { mediaType: file.mediaType || inferMediaType(managedPath) } : {}),
            sizeBytes: fs.statSync(managedPath).size,
            sha256: digest,
            source: input.source,
            createdAt: new Date().toISOString(),
          };
          const existingIndex = manifest.artifacts.findIndex((item) => item.id === record.id);
          if (existingIndex >= 0) manifest.artifacts[existingIndex] = record;
          else manifest.artifacts.push(record);
          records.push(record);
        }
        manifest.generatedAt = new Date().toISOString();
        commitMachineAndHumanProjection({
          machinePath: manifestPath,
          machineContent: `${JSON.stringify(manifest, null, 2)}\n`,
          humanPath: markdownPath,
          humanContent: renderArtifactManifestMarkdown(manifest),
        });
        return records;
      } catch (error) {
        for (const filePath of createdManagedPaths) {
          try { fs.unlinkSync(filePath); } catch { /* 事务回滚尽力完成 */ }
        }
        throw error;
      }
    });
  }

  promoteArtifact(rawRequest: ArtifactPromotionRequest): ArtifactPromotionResult {
    const request = parseArtifactPromotionRequest(rawRequest);
    const project = this.registeredProjects.find((item) => item.enabled && item.id === request.targetProjectId);
    if (!project) throw new Error('artifact_target_project_not_found');
    if (project.accessMode !== 'read_write') throw new Error('project_read_only');
    if (this.deniedRoots.some((root) => isPathInside(root, project.workspaceRoot))) throw new Error('artifact_target_project_denied');
    const found = this.findArtifact(request.artifactId);
    if (!found) throw new Error('artifact_not_found');
    const { turnDirectory } = found;
    return withManifestLock(turnDirectory, () => {
      const artifact = this.readArtifactFromTurn(turnDirectory, request.artifactId);
      if (!artifact) throw new Error('artifact_not_found');
      const actualDigest = sha256File(artifact.filePath);
      if (
        actualDigest !== artifact.sha256
        || makeArtifactId(artifact, artifact.relativePath, actualDigest) !== artifact.id
        || (request.expectedSha256 && request.expectedSha256 !== actualDigest)
      ) {
        throw new Error('artifact_hash_mismatch');
      }
      const targetPath = path.resolve(project.workspaceRoot, ...request.targetRelativePath.split('/'));
      if (!isPathInside(project.workspaceRoot, targetPath)) throw new Error('artifact_target_outside_project');
      if (this.deniedRoots.some((root) => isPathInside(root, targetPath))) throw new Error('artifact_target_project_denied');
      if (fs.existsSync(targetPath)) throw new Error('artifact_target_exists');
      assertNoSymlinkPath(project.workspaceRoot, path.dirname(targetPath));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      assertNoSymlinkPath(project.workspaceRoot, path.dirname(targetPath));
      const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.copyFileSync(artifact.filePath, temporaryPath, fs.constants.COPYFILE_EXCL);
        fs.renameSync(temporaryPath, targetPath);
        const result: ArtifactPromotionResult = {
          ok: true,
          artifactId: artifact.id,
          targetProjectId: project.id,
          targetPath,
          sha256: actualDigest,
          promotedAt: new Date().toISOString(),
        };
        const ledgerPath = path.join(turnDirectory, PROMOTION_LEDGER_NAME);
        const markdownPath = path.join(turnDirectory, PROMOTION_MARKDOWN_NAME);
        const existing = fs.existsSync(ledgerPath) && fs.lstatSync(ledgerPath).isFile()
          ? fs.readFileSync(ledgerPath, 'utf8').trimEnd()
          : '';
        const ledgerContent = `${existing ? `${existing}\n` : ''}${JSON.stringify(result)}\n`;
        commitMachineAndHumanProjection({
          machinePath: ledgerPath,
          machineContent: ledgerContent,
          humanPath: markdownPath,
          humanContent: renderPromotionMarkdown(parsePromotionLedger(ledgerContent)),
        });
        return result;
      } catch (error) {
        if (fs.existsSync(temporaryPath)) {
          try { fs.unlinkSync(temporaryPath); } catch { /* 原始错误优先 */ }
        }
        if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
          try { fs.unlinkSync(targetPath); } catch { /* 原始错误优先 */ }
        }
        throw error;
      }
    });
  }

  private readArtifactFromTurn(turnDirectory: string, artifactId: string): TurnArtifactRecord | undefined {
    const manifestPath = path.join(turnDirectory, MANIFEST_NAME);
    let manifest: TurnArtifactManifestV1;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TurnArtifactManifestV1;
      if (manifest.schema !== 'codex-im-suite/turn-artifacts/v1' || !Array.isArray(manifest.artifacts)) throw new Error('invalid');
    } catch {
      throw new Error('artifact_manifest_corrupt');
    }
    const record = manifest.artifacts.find((item) => item.id === artifactId);
    if (!record) return undefined;
    const resolvedFilePath = path.resolve(record.filePath);
    const relativePath = path.relative(turnDirectory, resolvedFilePath).replace(/\\/gu, '/');
    try {
      if (
        record.sessionId !== manifest.sessionId
        || record.turnId !== manifest.turnId
        || !isPathInside(turnDirectory, resolvedFilePath)
        || relativePath !== record.relativePath
        || !fs.existsSync(resolvedFilePath)
        || !fs.lstatSync(resolvedFilePath).isFile()
        || fs.lstatSync(resolvedFilePath).isSymbolicLink()
      ) throw new Error('invalid');
      assertNoSymlinkPath(turnDirectory, path.dirname(resolvedFilePath));
    } catch {
      throw new Error('artifact_manifest_corrupt');
    }
    return { ...record, filePath: resolvedFilePath };
  }

  private findArtifact(artifactId: string): { artifact: TurnArtifactRecord; turnDirectory: string } | undefined {
    if (!fs.existsSync(this.artifactRoot)) return undefined;
    for (const sessionEntry of fs.readdirSync(this.artifactRoot, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionPath = path.join(this.artifactRoot, sessionEntry.name);
      for (const turnEntry of fs.readdirSync(sessionPath, { withFileTypes: true })) {
        if (!turnEntry.isDirectory()) continue;
        const manifestPath = path.join(sessionPath, turnEntry.name, MANIFEST_NAME);
        if (!fs.existsSync(manifestPath)) continue;
        const record = this.readArtifactFromTurn(path.dirname(manifestPath), artifactId);
        if (record) return { artifact: record, turnDirectory: path.dirname(manifestPath) };
      }
    }
    return undefined;
  }
}

export function resolveArtifactTurnDirectory(root: string, scope: TurnScope): string {
  return resolveTurnDirectory(root, scope);
}
