import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ArtifactPromotionRequest,
  ArtifactPromotionResult,
  RegisteredProject,
  TurnArtifactRecord,
} from '@codex-im-suite/contracts';

import type {
  FileAttachment,
  StoredTurnFile,
  TurnStorageHost,
  TurnStorageScope,
} from 'claude-to-im/src/lib/bridge/host.js';
import { CODEX_HOME, CTI_HOME, type Config } from './config.js';
import { ArtifactStore } from './artifacts/artifact-store.js';
import {
  normalizeTurnSegment,
  resolveTurnDirectory,
  writeAtomic,
  writeAtomicProjection,
} from './artifacts/session-scratch.js';

export interface RuntimeTurnStorageOptions {
  uploadRoot: string;
  artifactRoot: string;
  scratchRoot: string;
  durableInputRoots?: string[];
  registeredProjects?: RegisteredProject[];
  deniedRoots?: string[];
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeFileName(name: string, index: number): string {
  const base = path.basename(name || `attachment-${index + 1}.bin`)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : `attachment-${index + 1}.bin`;
}

export function normalizeTurnStorageSegment(value: string, fallback: string): string {
  return normalizeTurnSegment(value, fallback);
}

export function resolveRuntimeTurnDirectory(root: string, scope: TurnStorageScope): string {
  return resolveTurnDirectory(root, scope);
}

function writeFileAtomic(filePath: string, data: Buffer): void {
  writeAtomic(filePath, data);
}

function escapeMarkdownCell(value: unknown): string {
  return String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function renderInputManifestMarkdown(manifest: {
  sessionId: string;
  turnId: string;
  createdAt: string;
  files: StoredTurnFile[];
}): string {
  const lines = [
    '# 输入附件清单',
    '',
    '> 此文件由 Runtime Turn Storage 根据 `输入附件清单.json` 自动生成；请勿手工修改。',
    '',
    `- 会话：${manifest.sessionId}`,
    `- 回合：${manifest.turnId}`,
    `- 创建时间：${manifest.createdAt}`,
    '',
    '| 名称 | 类型 | 大小（字节） | SHA-256 | 受管路径 |',
    '|---|---|---:|---|---|',
  ];
  for (const file of manifest.files) {
    lines.push(`| ${escapeMarkdownCell(file.name)} | ${escapeMarkdownCell(file.type)} | ${file.size} | ${file.sha256} | ${escapeMarkdownCell(file.filePath)} |`);
  }
  if (manifest.files.length === 0) lines.push('| 暂无 |  | 0 |  |  |');
  return `${lines.join('\n')}\n`;
}

function parseToolResultContent(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed) as unknown; } catch { return null; }
}

function collectArtifactFilePaths(value: unknown, active = false, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactFilePaths(item, active, out);
    return out;
  }
  if (typeof value === 'string') {
    if (active && path.isAbsolute(value) && fs.existsSync(value)) out.add(path.resolve(value));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const artifactField = /^(?:artifacts?|artifactPaths|images|files|filePath|localFiles)$/iu.test(key);
    collectArtifactFilePaths(nested, active || artifactField, out);
  }
  return out;
}

export class RuntimeTurnStorage implements TurnStorageHost {
  private readonly uploadRoot: string;
  private readonly artifactRoot: string;
  private readonly scratchRoot: string;
  private readonly durableInputRoots: string[];
  private readonly artifactStore: ArtifactStore;

  constructor(options: RuntimeTurnStorageOptions) {
    this.uploadRoot = path.resolve(options.uploadRoot);
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.scratchRoot = path.resolve(options.scratchRoot);
    this.durableInputRoots = (options.durableInputRoots || []).map((item) => path.resolve(item));
    this.artifactStore = new ArtifactStore({
      artifactRoot: this.artifactRoot,
      scratchRoot: this.scratchRoot,
      registeredProjects: options.registeredProjects || [],
      deniedRoots: options.deniedRoots,
    });
  }

  stageInputFiles(input: TurnStorageScope & { files: FileAttachment[] }): StoredTurnFile[] {
    const turnDirectory = resolveRuntimeTurnDirectory(this.uploadRoot, input);
    const existingTurnFiles = new Set(
      fs.existsSync(turnDirectory)
        ? fs.readdirSync(turnDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(turnDirectory, entry.name))
        : [],
    );
    let storedFiles: StoredTurnFile[] = [];
    try {
      storedFiles = input.files.map((file, index) => this.stageInputFile(turnDirectory, file, index));
      const manifest = {
        version: 1,
        sessionId: input.sessionId,
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
        files: storedFiles,
      };
      writeAtomicProjection({
        machinePath: path.join(turnDirectory, '输入附件清单.json'),
        machineContent: `${JSON.stringify(manifest, null, 2)}\n`,
        humanPath: path.join(turnDirectory, '输入附件清单.md'),
        humanContent: renderInputManifestMarkdown(manifest),
      });
      return storedFiles;
    } catch (error) {
      for (const file of storedFiles) {
        if (!isPathInside(turnDirectory, file.filePath) || existingTurnFiles.has(file.filePath)) continue;
        try { fs.unlinkSync(file.filePath); } catch { /* 投影失败时尽力回滚新暂存文件 */ }
      }
      throw error;
    }
  }

  getArtifactDirectory(input: TurnStorageScope): string {
    return this.artifactStore.getArtifactDirectory(input);
  }

  getScratchDirectory(input: TurnStorageScope): string {
    return this.artifactStore.getScratchDirectory(input);
  }

  registerArtifacts(input: TurnStorageScope & {
    files: Array<{ filePath: string; mediaType?: string }>;
    source: { kind: 'tool_result' | 'provider_output' | 'manual_import'; toolUseId?: string; toolName?: string };
  }): TurnArtifactRecord[] {
    return this.artifactStore.registerArtifacts(input);
  }

  registerToolResultArtifacts(input: TurnStorageScope & {
    toolUseId: string;
    toolName: string;
    content: unknown;
    isError: boolean;
  }): TurnArtifactRecord[] {
    if (input.isError) return [];
    const parsed = parseToolResultContent(input.content);
    if (!parsed || typeof parsed !== 'object') return [];
    const payload = parsed as Record<string, unknown>;
    if (payload.ok === false) return [];
    const explicitArtifactPayload = {
      artifacts: payload.artifacts,
      artifactPaths: payload.artifactPaths,
      images: payload.images,
      files: payload.files,
      data: payload.data && typeof payload.data === 'object'
        ? {
            artifacts: (payload.data as Record<string, unknown>).artifacts,
            artifactPaths: (payload.data as Record<string, unknown>).artifactPaths,
            images: (payload.data as Record<string, unknown>).images,
            files: (payload.data as Record<string, unknown>).files,
            result: (payload.data as Record<string, unknown>).result,
          }
        : undefined,
    };
    const paths = [...collectArtifactFilePaths(explicitArtifactPayload)];
    if (paths.length === 0) return [];
    return this.registerArtifacts({
      sessionId: input.sessionId,
      turnId: input.turnId,
      files: paths.map((filePath) => ({ filePath })),
      source: { kind: 'tool_result', toolUseId: input.toolUseId, toolName: input.toolName },
    });
  }

  promoteArtifact(input: ArtifactPromotionRequest): ArtifactPromotionResult {
    return this.artifactStore.promoteArtifact(input);
  }

  private stageInputFile(turnDirectory: string, file: FileAttachment, index: number): StoredTurnFile {
    const existingPath = file.filePath?.trim() ? path.resolve(file.filePath.trim()) : '';
    const existingBuffer = existingPath && fs.existsSync(existingPath) && fs.statSync(existingPath).isFile()
      ? fs.readFileSync(existingPath)
      : null;
    const buffer = existingBuffer || (file.data ? Buffer.from(file.data, 'base64') : null);
    if (!buffer) {
      throw new Error(`附件没有可读取内容：${file.name || file.id}`);
    }
    const digest = sha256(buffer);

    if (existingPath && this.durableInputRoots.some((root) => isPathInside(root, existingPath))) {
      return {
        id: file.id,
        name: file.name,
        type: file.type,
        size: buffer.length,
        filePath: existingPath,
        sha256: digest,
      };
    }

    if (existingPath && isPathInside(turnDirectory, existingPath)) {
      return {
        id: file.id,
        name: file.name,
        type: file.type,
        size: buffer.length,
        filePath: existingPath,
        sha256: digest,
      };
    }

    const fileName = `${String(index + 1).padStart(2, '0')}-${digest.slice(0, 12)}-${safeFileName(file.name, index)}`;
    const filePath = path.join(turnDirectory, fileName);
    if (!fs.existsSync(filePath)) writeFileAtomic(filePath, buffer);
    return {
      id: file.id,
      name: file.name,
      type: file.type,
      size: buffer.length,
      filePath,
      sha256: digest,
    };
  }
}

export function createRuntimeTurnStorage(config: Config): RuntimeTurnStorage {
  return new RuntimeTurnStorage({
    uploadRoot: config.uploadCacheDir || path.join(CTI_HOME, 'runtime', 'uploads'),
    artifactRoot: path.join(CTI_HOME, 'runtime', 'artifacts'),
    scratchRoot: path.join(CTI_HOME, 'runtime', 'workspaces'),
    durableInputRoots: config.memoryRepoDir ? [config.memoryRepoDir] : [],
    registeredProjects: config.registeredProjects || [],
    deniedRoots: [
      CTI_HOME,
      CODEX_HOME,
      ...(config.memoryRepoDir ? [config.memoryRepoDir] : []),
      ...(config.uploadCacheDir ? [config.uploadCacheDir] : []),
      ...(config.projectDeniedRoots || []),
    ],
  });
}

export function stageProviderInputFiles(
  storage: Pick<TurnStorageHost, 'stageInputFiles'>,
  input: TurnStorageScope & { files?: FileAttachment[] },
): string[] {
  if (!input.files?.length) return [];
  return storage.stageInputFiles({
    sessionId: input.sessionId,
    turnId: input.turnId,
    files: input.files,
  }).map((file) => file.filePath);
}
