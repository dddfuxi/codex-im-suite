import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SkillRegistryItem, SkillRegistrySnapshot } from 'claude-to-im/host';
import { CODEX_HOME, CTI_HOME, resolveSuiteRoot } from './config.js';

interface SkillManifest {
  id?: string;
  displayName?: string;
  type?: string;
  version?: string;
  source?: string;
  enabled?: boolean;
  description?: string;
}

export interface SkillRegistryOptions {
  ctiHome?: string;
  codexHome?: string;
  suiteRoot?: string;
  now?: () => Date;
}

export interface SkillRegistry {
  readonly registryPath: string;
  readonly draftRoot: string;
  read(): SkillRegistrySnapshot;
  refresh(): SkillRegistrySnapshot;
  upsert(item: SkillRegistryItem): SkillRegistryItem;
}

const PROTOCOL = 'cti-skill-registry/v1' as const;

function emptySnapshot(now: () => Date): SkillRegistrySnapshot {
  return { protocol: PROTOCOL, generatedAt: now().toISOString(), items: [] };
}

function isSnapshot(value: unknown): value is SkillRegistrySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<SkillRegistrySnapshot>;
  return record.protocol === PROTOCOL && typeof record.generatedAt === 'string' && Array.isArray(record.items);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function readSnapshot(filePath: string): SkillRegistrySnapshot | null {
  try {
    const parsed = readJsonFile(filePath);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function contentHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseSkillName(skillPath: string, fallback: string): string {
  const text = fs.readFileSync(skillPath, 'utf8');
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] || '';
  return frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || fallback;
}

function scanSkillDirectories(
  root: string,
  sourceClass: 'installed' | 'self_created',
  state: 'enabled' | 'disabled' | 'draft',
  now: () => Date,
): SkillRegistryItem[] {
  if (!fs.existsSync(root)) return [];
  const items: SkillRegistryItem[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillDir = path.resolve(root, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    items.push({
      id: entry.name,
      displayName: parseSkillName(skillPath, entry.name),
      sourceClass,
      source: skillPath,
      path: skillDir,
      contentHash: contentHash(skillPath),
      state,
      risk: 'low',
      enabled: state === 'enabled',
      updatedAt: now().toISOString(),
    });
  }
  return items;
}

function expandManifestSource(source: string | undefined, suiteRoot: string, ctiHome: string, codexHome: string): string | undefined {
  if (!source?.trim()) return undefined;
  const expanded = source
    .replace(/\$\{SUITE_ROOT\}/gu, suiteRoot)
    .replace(/\$\{CTI_HOME\}/gu, ctiHome)
    .replace(/\$\{CODEX_HOME\}/gu, codexHome);
  return path.resolve(expanded);
}

function scanManifests(suiteRoot: string, ctiHome: string, codexHome: string, now: () => Date): SkillRegistryItem[] {
  const manifestRoot = path.join(suiteRoot, 'config', 'skills.d');
  if (!fs.existsSync(manifestRoot)) return [];
  const items: SkillRegistryItem[] = [];
  for (const entry of fs.readdirSync(manifestRoot, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
    try {
      const manifest = readJsonFile(path.join(manifestRoot, entry.name)) as SkillManifest;
      if (manifest.type !== 'skill' || !manifest.id?.trim()) continue;
      const sourcePath = expandManifestSource(manifest.source, suiteRoot, ctiHome, codexHome);
      items.push({
        id: manifest.id.trim(),
        displayName: manifest.displayName?.trim() || manifest.id.trim(),
        version: manifest.version?.trim() || undefined,
        sourceClass: 'whitelist',
        source: sourcePath,
        path: sourcePath && fs.existsSync(sourcePath) ? sourcePath : undefined,
        state: 'discovered',
        risk: 'low',
        enabled: false,
        updatedAt: now().toISOString(),
      });
    } catch {
      // A broken catalog entry is ignored; it must not hide installed skills.
    }
  }
  return items;
}

function mergeItems(previous: SkillRegistrySnapshot, discovered: SkillRegistryItem[]): SkillRegistryItem[] {
  const previousById = new Map(previous.items.map((item) => [item.id, item]));
  const merged = new Map<string, SkillRegistryItem>();
  for (const item of discovered) {
    const old = previousById.get(item.id);
    merged.set(item.id, {
      ...old,
      ...item,
      relatedProjects: old?.relatedProjects,
      validation: old?.validation,
      approval: old?.approval,
      failureSummary: old?.failureSummary,
      rollbackPath: old?.rollbackPath,
    });
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function atomicWriteSnapshot(registryPath: string, snapshot: SkillRegistrySnapshot): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const backupPath = `${registryPath}.bak`;
  const existing = readSnapshot(registryPath);
  if (existing) fs.copyFileSync(registryPath, backupPath);
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(tempPath, registryPath);
}

export function createSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistry {
  const ctiHome = path.resolve(options.ctiHome || CTI_HOME);
  const codexHome = path.resolve(options.codexHome || CODEX_HOME);
  const suiteRoot = path.resolve(options.suiteRoot || resolveSuiteRoot());
  const now = options.now || (() => new Date());
  const registryPath = path.join(ctiHome, 'data', 'skill-registry.json');
  const draftRoot = path.join(ctiHome, 'extensions', 'drafts', 'skills');
  const disabledRoot = path.join(ctiHome, 'extensions', 'disabled', 'skills');
  const installedRoot = path.join(codexHome, 'skills');

  const read = (): SkillRegistrySnapshot => readSnapshot(registryPath)
    || readSnapshot(`${registryPath}.bak`)
    || emptySnapshot(now);

  const refresh = (): SkillRegistrySnapshot => {
    const previous = read();
    // Precedence is explicit: installed > draft > manifest.
    const discovered = [
      ...scanManifests(suiteRoot, ctiHome, codexHome, now),
      ...scanSkillDirectories(draftRoot, 'self_created', 'draft', now),
      ...scanSkillDirectories(disabledRoot, 'installed', 'disabled', now),
      ...scanSkillDirectories(installedRoot, 'installed', 'enabled', now),
    ];
    const snapshot: SkillRegistrySnapshot = {
      protocol: PROTOCOL,
      generatedAt: now().toISOString(),
      items: mergeItems(previous, discovered),
    };
    atomicWriteSnapshot(registryPath, snapshot);
    return snapshot;
  };

  const upsert = (item: SkillRegistryItem): SkillRegistryItem => {
    const snapshot = read();
    const items = snapshot.items.filter((candidate) => candidate.id !== item.id);
    items.push(item);
    atomicWriteSnapshot(registryPath, {
      protocol: PROTOCOL,
      generatedAt: now().toISOString(),
      items: items.sort((left, right) => left.id.localeCompare(right.id)),
    });
    return item;
  };

  return { registryPath, draftRoot, read, refresh, upsert };
}
