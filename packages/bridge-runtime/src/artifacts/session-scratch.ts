import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TurnScope {
  sessionId: string;
  turnId: string;
}

interface FileSnapshot {
  exists: boolean;
  isFile: boolean;
  content?: Buffer;
}

function snapshotFile(filePath: string): FileSnapshot {
  if (!fs.existsSync(filePath)) return { exists: false, isFile: false };
  const stat = fs.lstatSync(filePath);
  return stat.isFile()
    ? { exists: true, isFile: true, content: fs.readFileSync(filePath) }
    : { exists: true, isFile: false };
}

function restoreFile(filePath: string, snapshot: FileSnapshot): void {
  if (snapshot.exists && snapshot.isFile && snapshot.content) {
    writeAtomic(filePath, snapshot.content);
    return;
  }
  if (!snapshot.exists && fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
    fs.unlinkSync(filePath);
  }
}

export function normalizeTurnSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(trimmed)) return trimmed;
  const readable = trimmed
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || fallback;
  const suffix = crypto.createHash('sha256').update(trimmed || fallback).digest('hex').slice(0, 12);
  return `${readable}-${suffix}`;
}

export function resolveTurnDirectory(root: string, scope: TurnScope): string {
  return path.join(
    path.resolve(root),
    normalizeTurnSegment(scope.sessionId, 'session'),
    normalizeTurnSegment(scope.turnId, 'turn'),
  );
}

export function writeAtomic(filePath: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, data);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      try { fs.unlinkSync(temporaryPath); } catch { /* 原始错误优先 */ }
    }
  }
}

export function writeAtomicProjection(input: {
  machinePath: string;
  machineContent: string;
  humanPath: string;
  humanContent: string;
}): void {
  const machineBefore = snapshotFile(input.machinePath);
  const humanBefore = snapshotFile(input.humanPath);
  try {
    writeAtomic(input.machinePath, input.machineContent);
    writeAtomic(input.humanPath, input.humanContent);
  } catch (error) {
    try { restoreFile(input.machinePath, machineBefore); } catch { /* 保留原始失败 */ }
    try { restoreFile(input.humanPath, humanBefore); } catch { /* 保留原始失败 */ }
    throw error;
  }
}

function renderTurnMetadataMarkdown(metadata: {
  schema: string;
  kind: 'artifact' | 'scratch';
  sessionId: string;
  turnId: string;
  createdAt: string;
}): string {
  return [
    '# 回合元数据',
    '',
    '> 此文件由 Runtime Turn Storage 根据 `回合元数据.json` 自动生成；请勿手工修改。',
    '',
    `- 类型：${metadata.kind}`,
    `- 会话：${metadata.sessionId}`,
    `- 回合：${metadata.turnId}`,
    `- 创建时间：${metadata.createdAt}`,
    `- 协议：${metadata.schema}`,
    '',
  ].join('\n');
}

export function ensureTurnDirectory(root: string, scope: TurnScope, kind: 'artifact' | 'scratch'): string {
  const directory = resolveTurnDirectory(root, scope);
  fs.mkdirSync(directory, { recursive: true });
  const metadataPath = path.join(directory, '回合元数据.json');
  const markdownPath = path.join(directory, '回合元数据.md');
  let metadata: {
    schema: string;
    kind: 'artifact' | 'scratch';
    sessionId: string;
    turnId: string;
    createdAt: string;
  };
  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as typeof metadata;
  } else {
    metadata = {
      schema: 'codex-im-suite/turn-storage-metadata/v1',
      kind,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      createdAt: new Date().toISOString(),
    };
  }
  if (!fs.existsSync(metadataPath) || !fs.existsSync(markdownPath)) {
    writeAtomicProjection({
      machinePath: metadataPath,
      machineContent: `${JSON.stringify(metadata, null, 2)}\n`,
      humanPath: markdownPath,
      humanContent: renderTurnMetadataMarkdown(metadata),
    });
  }
  return directory;
}
