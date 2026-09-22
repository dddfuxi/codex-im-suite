import fs from 'node:fs';
import path from 'node:path';

import type { PromptSnapshotRecord } from 'claude-to-im/host';
import { CTI_HOME } from './config.js';

export interface PromptSnapshotStoreState {
  protocol: 'cti-prompt-snapshot-store/v1';
  policy: { maxItems: number; maxAgeDays: number };
  snapshots: PromptSnapshotRecord[];
}

export interface PromptSnapshotStoreOptions {
  ctiHome?: string;
  maxItems?: number;
  maxAgeDays?: number;
  now?: () => Date;
}

export interface PromptSnapshotStore {
  readonly filePath: string;
  read(): PromptSnapshotStoreState;
  record(snapshot: PromptSnapshotRecord): void;
}

function isState(value: unknown): value is PromptSnapshotStoreState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<PromptSnapshotStoreState>;
  return record.protocol === 'cti-prompt-snapshot-store/v1' && Array.isArray(record.snapshots);
}

function readState(filePath: string): PromptSnapshotStoreState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return isState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createPromptSnapshotStore(options: PromptSnapshotStoreOptions = {}): PromptSnapshotStore {
  const filePath = path.join(path.resolve(options.ctiHome || CTI_HOME), 'runtime', 'prompt-snapshots.json');
  const maxItems = Math.max(1, options.maxItems ?? 100);
  const maxAgeDays = Math.max(1, options.maxAgeDays ?? 7);
  const now = options.now || (() => new Date());
  const empty = (): PromptSnapshotStoreState => ({
    protocol: 'cti-prompt-snapshot-store/v1',
    policy: { maxItems, maxAgeDays },
    snapshots: [],
  });
  const read = (): PromptSnapshotStoreState => readState(filePath) || readState(`${filePath}.bak`) || empty();
  const record = (snapshot: PromptSnapshotRecord): void => {
    const state = read();
    const cutoff = now().getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    const snapshots = [...state.snapshots, snapshot]
      .filter((item) => Date.parse(item.createdAt) >= cutoff)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(-maxItems);
    const next: PromptSnapshotStoreState = {
      protocol: 'cti-prompt-snapshot-store/v1',
      policy: { maxItems, maxAgeDays },
      snapshots,
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (readState(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  };
  return { filePath, read, record };
}
