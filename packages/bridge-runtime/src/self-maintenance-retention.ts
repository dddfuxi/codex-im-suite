import fs from 'node:fs';
import path from 'node:path';

export interface SelfMaintenanceRetentionOptions {
  maxActiveVersionDirectories?: number;
  maxActiveAuditLines?: number;
  archiveAfterDays?: number;
  now?: Date;
}

export interface SelfMaintenanceRetentionResult {
  archivedVersionDirectories: number;
  archivedAuditLines: number;
  archivedDailyReflections: number;
  archivedCorrections: number;
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function moveIntoArchive(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.renameSync(sourcePath, targetPath);
  return true;
}

function archiveDatedMarkdown(input: {
  sourceRoot: string;
  archiveRoot: string;
  filePattern: RegExp;
  cutoffTime: number;
}): number {
  if (!fs.existsSync(input.sourceRoot)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(input.sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const dateKey = entry.name.match(input.filePattern)?.[1];
    if (!dateKey) continue;
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.getTime() >= input.cutoffTime) continue;
    if (moveIntoArchive(path.join(input.sourceRoot, entry.name), path.join(input.archiveRoot, entry.name))) count += 1;
  }
  return count;
}

export function rotateSelfMaintenanceHistory(
  memoryRoot: string,
  options: SelfMaintenanceRetentionOptions = {},
): SelfMaintenanceRetentionResult {
  const maxVersions = Math.max(1, Math.floor(options.maxActiveVersionDirectories ?? 50));
  const maxAuditLines = Math.max(1, Math.floor(options.maxActiveAuditLines ?? 2_000));
  const archiveAfterDays = Math.max(1, Math.floor(options.archiveAfterDays ?? 90));
  const now = options.now || new Date();
  const archiveRoot = path.join(memoryRoot, 'archive', 'self-maintenance');
  let archivedVersionDirectories = 0;
  let archivedAuditLines = 0;

  const versionsRoot = path.join(memoryRoot, '.cti-self-history', 'versions');
  if (fs.existsSync(versionsRoot)) {
    const directories = fs.readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const name of directories.slice(0, Math.max(0, directories.length - maxVersions))) {
      if (moveIntoArchive(path.join(versionsRoot, name), path.join(archiveRoot, 'versions', name))) {
        archivedVersionDirectories += 1;
      }
    }
  }

  const auditPath = path.join(memoryRoot, '.cti-self-history', '自维护审计.jsonl');
  if (fs.existsSync(auditPath)) {
    const lines = fs.readFileSync(auditPath, 'utf8').split(/\r?\n/gu).filter(Boolean);
    if (lines.length > maxAuditLines) {
      const archived = lines.slice(0, lines.length - maxAuditLines);
      const safeTimestamp = now.toISOString().replace(/[:.]/gu, '-');
      const archivePath = path.join(archiveRoot, 'audit', `自维护审计-${safeTimestamp}.jsonl`);
      atomicWrite(archivePath, `${archived.join('\n')}\n`);
      atomicWrite(auditPath, `${lines.slice(-maxAuditLines).join('\n')}\n`);
      archivedAuditLines = archived.length;
    }
  }

  const cutoffTime = now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1_000;
  const archivedDailyReflections = archiveDatedMarkdown({
    sourceRoot: path.join(memoryRoot, 'daily-reflection'),
    archiveRoot: path.join(archiveRoot, 'daily-reflection'),
    filePattern: /^每日反思-(\d{4}-\d{2}-\d{2})\.md$/u,
    cutoffTime,
  });
  const archivedCorrections = archiveDatedMarkdown({
    sourceRoot: path.join(memoryRoot, 'corrections'),
    archiveRoot: path.join(archiveRoot, 'corrections'),
    filePattern: /^纠错记录-(\d{4}-\d{2}-\d{2})\.md$/u,
    cutoffTime,
  });

  return {
    archivedVersionDirectories,
    archivedAuditLines,
    archivedDailyReflections,
    archivedCorrections,
  };
}
