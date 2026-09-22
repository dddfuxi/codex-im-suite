import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBridgeContext, hasBridgeContext } from './context.js';
import type { BridgeStore } from './host.js';

const WINDOWS_DEFAULT_MEMORY_REPO_DIR = 'E:\\cli-md';

function defaultCtiHome(): string {
  return process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
}

function defaultMemoryRepoDir(): string {
  return process.platform === 'win32'
    ? WINDOWS_DEFAULT_MEMORY_REPO_DIR
    : path.join(defaultCtiHome(), 'memory-repo');
}

function normalizeRoot(root: string): string {
  const trimmed = root.trim();
  return path.resolve(trimmed || defaultMemoryRepoDir());
}

export class MemoryArtifactStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = normalizeRoot(root || defaultMemoryRepoDir());
  }

  static stableFileName(key: string, extension = ''): string {
    const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    const normalizedExtension = extension && extension.startsWith('.') ? extension : extension ? `.${extension}` : '';
    return `${digest}${normalizedExtension}`;
  }

  resolve(...segments: string[]): string {
    return path.join(this.root, ...segments);
  }

  feishuStickerStorePath(): string {
    return this.resolve('data', 'im', 'feishu', 'stickers', 'stickers.json');
  }

  feishuStickerMediaDirPath(): string {
    return this.resolve('data', 'im', 'feishu', 'stickers', 'media');
  }

  feishuChatSummaryDirPath(chatId?: string): string {
    const base = this.resolve('data', 'im', 'feishu', 'summaries');
    return chatId?.trim() ? path.join(base, MemoryArtifactStore.stableFileName(chatId.trim())) : base;
  }

  projectFactsPath(): string {
    return this.resolve('data', 'projects', 'facts.json');
  }

  readJson<T>(filePath: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }
}

export function resolveBridgeMemoryArtifactRoot(store?: Pick<BridgeStore, 'getSetting'>): string {
  const configured = store?.getSetting('bridge_memory_repo_dir')
    || process.env.CTI_MEMORY_REPO_DIR
    || (hasBridgeContext() ? getBridgeContext().store.getSetting('bridge_memory_repo_dir') : null)
    || defaultMemoryRepoDir();
  return normalizeRoot(configured);
}

export function createBridgeMemoryArtifactStore(store?: Pick<BridgeStore, 'getSetting'>): MemoryArtifactStore {
  return new MemoryArtifactStore(resolveBridgeMemoryArtifactRoot(store));
}
