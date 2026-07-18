import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  FileAttachment,
  StoredTurnFile,
  TurnStorageHost,
  TurnStorageScope,
} from 'claude-to-im/src/lib/bridge/host.js';
import { CTI_HOME, type Config } from './config.js';

export interface RuntimeTurnStorageOptions {
  uploadRoot: string;
  artifactRoot: string;
  scratchRoot: string;
  durableInputRoots?: string[];
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
  const trimmed = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(trimmed)) return trimmed;
  const readable = trimmed
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || fallback;
  const suffix = crypto.createHash('sha256').update(trimmed || fallback).digest('hex').slice(0, 12);
  return `${readable}-${suffix}`;
}

export function resolveRuntimeTurnDirectory(root: string, scope: TurnStorageScope): string {
  return path.join(
    path.resolve(root),
    normalizeTurnStorageSegment(scope.sessionId, 'session'),
    normalizeTurnStorageSegment(scope.turnId, 'turn'),
  );
}

function writeFileAtomic(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, data);
  fs.renameSync(temporaryPath, filePath);
}

export class RuntimeTurnStorage implements TurnStorageHost {
  private readonly uploadRoot: string;
  private readonly artifactRoot: string;
  private readonly scratchRoot: string;
  private readonly durableInputRoots: string[];

  constructor(options: RuntimeTurnStorageOptions) {
    this.uploadRoot = path.resolve(options.uploadRoot);
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.scratchRoot = path.resolve(options.scratchRoot);
    this.durableInputRoots = (options.durableInputRoots || []).map((item) => path.resolve(item));
  }

  stageInputFiles(input: TurnStorageScope & { files: FileAttachment[] }): StoredTurnFile[] {
    const turnDirectory = resolveRuntimeTurnDirectory(this.uploadRoot, input);
    const storedFiles = input.files.map((file, index) => this.stageInputFile(turnDirectory, file, index));
    const manifest = {
      version: 1,
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt: new Date().toISOString(),
      files: storedFiles,
    };
    writeFileAtomic(
      path.join(turnDirectory, '输入附件清单.json'),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    );
    return storedFiles;
  }

  getArtifactDirectory(input: TurnStorageScope): string {
    return resolveRuntimeTurnDirectory(this.artifactRoot, input);
  }

  getScratchDirectory(input: TurnStorageScope): string {
    return resolveRuntimeTurnDirectory(this.scratchRoot, input);
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
