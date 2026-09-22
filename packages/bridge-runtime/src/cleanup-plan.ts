import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type CleanupClassification =
  | 'legacy_upload_cache'
  | 'runtime_upload_cache'
  | 'test_fixture'
  | 'explicit_artifact'
  | 'unity_asset'
  | 'source_file'
  | 'unknown';

export type WorkspaceCleanupMode = 'dry-run' | 'applied' | 'restored';

export interface WorkspaceCleanupFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  gitStatus: string;
}

export interface WorkspaceCleanupTarget {
  originalPath: string;
  backupPath: string;
  classification: CleanupClassification;
  automaticCleanupAllowed: boolean;
  gitStatus: string;
  fileCount: number;
  totalBytes: number;
  lastModifiedAt: string | null;
  files: WorkspaceCleanupFile[];
}

export interface WorkspaceCleanupPlan {
  schema: 'codex-im-suite/workspace-cleanup/v1';
  mode: WorkspaceCleanupMode;
  createdAt: string;
  appliedAt?: string;
  restoredAt?: string;
  ctiHome: string;
  backupRoot: string;
  reportJsonPath: string;
  reportMarkdownPath: string;
  targets: WorkspaceCleanupTarget[];
  totals: {
    targetCount: number;
    fileCount: number;
    totalBytes: number;
  };
}

export interface BuildWorkspaceCleanupPlanOptions {
  targets: string[];
  ctiHome: string;
  now?: string;
}

export interface CleanupMutationOptions {
  assertProcessesStopped?: () => void;
}

const AUTO_CLEANUP_CLASSIFICATIONS = new Set<CleanupClassification>([
  'legacy_upload_cache',
  'runtime_upload_cache',
  'test_fixture',
]);

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizedSegments(value: string): string[] {
  return path.resolve(value).split(/[\\/]+/u).filter(Boolean).map((segment) => segment.toLowerCase());
}

export function classifyCleanupPath(targetPath: string, ctiHome: string): CleanupClassification {
  const resolved = path.resolve(targetPath);
  const segments = normalizedSegments(resolved);
  const baseName = path.basename(resolved).toLowerCase();
  if (baseName === '.codepilot-uploads') return 'legacy_upload_cache';
  if (isPathInside(path.join(path.resolve(ctiHome), 'runtime', 'uploads'), resolved)) return 'runtime_upload_cache';
  if (segments.some((segment) => ['__tests__', 'test-fixtures', 'test_fixture', 'fixtures'].includes(segment))) return 'test_fixture';
  if (segments.includes('assets')) return 'unity_asset';
  if (segments.some((segment) => ['artifacts', 'artifact', 'captures', 'codex-output', 'output'].includes(segment))) return 'explicit_artifact';
  if (segments.some((segment) => ['src', '.git'].includes(segment))) return 'source_file';
  return 'unknown';
}

function timestampLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`无效时间：${iso}`);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function assertSafeTarget(targetPath: string, ctiHome: string, backupRoot: string): void {
  const resolved = path.resolve(targetPath);
  const parsedRoot = path.parse(resolved).root;
  if (resolved === parsedRoot) throw new Error(`拒绝清理磁盘根目录：${resolved}`);
  if (resolved === path.resolve(ctiHome)) throw new Error(`拒绝清理 CTI_HOME 根目录：${resolved}`);
  if (isPathInside(resolved, backupRoot) || isPathInside(backupRoot, resolved)) {
    throw new Error(`清理目标与备份目录重叠：${resolved}`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`清理目标不存在：${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory()) throw new Error(`清理目标必须是目录：${resolved}`);
  if (stat.isSymbolicLink()) throw new Error(`拒绝清理符号链接或目录联接：${resolved}`);
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function listFiles(targetPath: string): Array<{ absolutePath: string; relativePath: string; stat: fs.Stats }> {
  const files: Array<{ absolutePath: string; relativePath: string; stat: fs.Stats }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`清理目标包含符号链接或目录联接，拒绝继续：${absolutePath}`);
      }
      if (stat.isDirectory()) visit(absolutePath);
      else if (stat.isFile()) files.push({
        absolutePath,
        relativePath: path.relative(targetPath, absolutePath),
        stat,
      });
    }
  };
  visit(targetPath);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'));
}

function findGitRoot(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readGitStatus(targetPath: string): string {
  const gitRoot = findGitRoot(targetPath);
  if (!gitRoot) return 'outside_git';
  const relative = path.relative(gitRoot, targetPath) || '.';
  const result = spawnSync('git', ['-C', gitRoot, 'status', '--porcelain', '--ignored', '--untracked-files=all', '--', relative], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return 'git_status_error';
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => line.startsWith('!!'))) return 'ignored';
  if (lines.some((line) => line.startsWith('??'))) return 'untracked';
  if (lines.length > 0) return 'tracked_modified';
  return 'clean';
}

function buildTarget(
  targetPath: string,
  backupPath: string,
  ctiHome: string,
): WorkspaceCleanupTarget {
  const resolved = path.resolve(targetPath);
  const classification = classifyCleanupPath(resolved, ctiHome);
  const gitStatus = readGitStatus(resolved);
  const files = listFiles(resolved).map(({ absolutePath, relativePath, stat }): WorkspaceCleanupFile => ({
    relativePath,
    absolutePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: hashFile(absolutePath),
    gitStatus,
  }));
  const latest = files.reduce<Date | null>((current, file) => {
    const modifiedAt = new Date(file.modifiedAt);
    return !current || modifiedAt > current ? modifiedAt : current;
  }, null);
  return {
    originalPath: resolved,
    backupPath,
    classification,
    automaticCleanupAllowed: AUTO_CLEANUP_CLASSIFICATIONS.has(classification),
    gitStatus,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    lastModifiedAt: latest?.toISOString() || null,
    files,
  };
}

export function buildWorkspaceCleanupPlan(options: BuildWorkspaceCleanupPlanOptions): WorkspaceCleanupPlan {
  if (!options.targets.length) throw new Error('至少需要一个清理目标');
  const ctiHome = path.resolve(options.ctiHome);
  const createdAt = options.now || new Date().toISOString();
  const label = timestampLabel(createdAt);
  const backupRoot = path.join(ctiHome, 'backups', 'workspace-cleanup', label);
  const uniqueTargets = [...new Set(options.targets.map((target) => path.resolve(target)))];
  uniqueTargets.forEach((target) => assertSafeTarget(target, ctiHome, backupRoot));
  const targets = uniqueTargets.map((target, index) => buildTarget(
    target,
    path.join(backupRoot, 'payload', `${String(index + 1).padStart(2, '0')}-${path.basename(target)}`),
    ctiHome,
  ));
  const fileCount = targets.reduce((sum, target) => sum + target.fileCount, 0);
  const totalBytes = targets.reduce((sum, target) => sum + target.totalBytes, 0);
  return {
    schema: 'codex-im-suite/workspace-cleanup/v1',
    mode: 'dry-run',
    createdAt,
    ctiHome,
    backupRoot,
    reportJsonPath: path.join(backupRoot, `工作区污染清理清单-${label}.json`),
    reportMarkdownPath: path.join(backupRoot, `工作区污染清理清单-${label}.md`),
    targets,
    totals: { targetCount: targets.length, fileCount, totalBytes },
  };
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function buildMarkdown(plan: WorkspaceCleanupPlan): string {
  const lines = [
    '# 工作区污染清理清单',
    '',
    `- 状态：${plan.mode}`,
    `- 创建时间：${plan.createdAt}`,
    `- 目标数：${plan.totals.targetCount}`,
    `- 文件数：${plan.totals.fileCount}`,
    `- 总大小：${formatBytes(plan.totals.totalBytes)}`,
    `- 隔离备份：${plan.backupRoot}`,
    '',
    '> 默认仅生成计划，不会永久删除。Apply 只把允许的缓存目录移动到隔离备份；可使用同一 JSON manifest 恢复。',
    '',
    '| 原路径 | 分类 | 自动清理 | Git 状态 | 文件数 | 大小 | 最后修改 | 备份路径 |',
    '|---|---|---:|---|---:|---:|---|---|',
  ];
  for (const target of plan.targets) {
    lines.push(`| ${target.originalPath} | ${target.classification} | ${target.automaticCleanupAllowed ? '是' : '否'} | ${target.gitStatus} | ${target.fileCount} | ${formatBytes(target.totalBytes)} | ${target.lastModifiedAt || '-'} | ${target.backupPath} |`);
  }
  lines.push('', '## 文件 Hash', '');
  for (const target of plan.targets) {
    lines.push(`### ${target.originalPath}`, '');
    for (const file of target.files) lines.push(`- \`${file.sha256}\` ${file.relativePath}（${formatBytes(file.size)}）`);
    if (target.files.length === 0) lines.push('- 空目录');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function writeWorkspaceCleanupReports(plan: WorkspaceCleanupPlan): { jsonPath: string; markdownPath: string } {
  atomicWrite(plan.reportJsonPath, `${JSON.stringify(plan, null, 2)}\n`);
  atomicWrite(plan.reportMarkdownPath, buildMarkdown(plan));
  return { jsonPath: plan.reportJsonPath, markdownPath: plan.reportMarkdownPath };
}

function verifyTargetFiles(root: string, files: WorkspaceCleanupFile[]): void {
  for (const file of files) {
    const currentPath = path.join(root, file.relativePath);
    if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isFile()) {
      throw new Error(`清理清单文件缺失：${currentPath}`);
    }
    const currentHash = hashFile(currentPath);
    if (currentHash !== file.sha256) throw new Error(`清理清单 Hash 不匹配：${currentPath}`);
  }
}

export function applyWorkspaceCleanupPlan(
  plan: WorkspaceCleanupPlan,
  options: CleanupMutationOptions = {},
): WorkspaceCleanupPlan {
  options.assertProcessesStopped?.();
  if (plan.mode !== 'dry-run') throw new Error(`只有 dry-run 清单可以 Apply，当前状态：${plan.mode}`);
  for (const target of plan.targets) {
    if (!target.automaticCleanupAllowed) {
      throw new Error(`分类 ${target.classification} 不允许自动清理：${target.originalPath}`);
    }
    assertSafeTarget(target.originalPath, plan.ctiHome, plan.backupRoot);
    verifyTargetFiles(target.originalPath, target.files);
    if (fs.existsSync(target.backupPath)) throw new Error(`隔离备份目标已存在：${target.backupPath}`);
  }
  fs.mkdirSync(path.join(plan.backupRoot, 'payload'), { recursive: true });
  const applied = structuredClone(plan);
  for (const target of applied.targets) {
    fs.mkdirSync(path.dirname(target.backupPath), { recursive: true });
    try {
      fs.renameSync(target.originalPath, target.backupPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        throw new Error(`清理目标与备份目录不在同一磁盘，拒绝复制后删除：${target.originalPath}`);
      }
      throw error;
    }
    verifyTargetFiles(target.backupPath, target.files);
  }
  applied.mode = 'applied';
  applied.appliedAt = new Date().toISOString();
  writeWorkspaceCleanupReports(applied);
  return applied;
}

export function restoreWorkspaceCleanupPlan(
  plan: WorkspaceCleanupPlan,
  options: CleanupMutationOptions = {},
): WorkspaceCleanupPlan {
  options.assertProcessesStopped?.();
  if (plan.mode !== 'applied') throw new Error(`只有 applied 清单可以恢复，当前状态：${plan.mode}`);
  for (const target of plan.targets) {
    if (fs.existsSync(target.originalPath)) throw new Error(`原路径已存在，拒绝覆盖恢复：${target.originalPath}`);
    if (!fs.existsSync(target.backupPath)) throw new Error(`隔离备份不存在：${target.backupPath}`);
    verifyTargetFiles(target.backupPath, target.files);
  }
  const restored = structuredClone(plan);
  for (const target of restored.targets) {
    fs.mkdirSync(path.dirname(target.originalPath), { recursive: true });
    fs.renameSync(target.backupPath, target.originalPath);
    verifyTargetFiles(target.originalPath, target.files);
  }
  restored.mode = 'restored';
  restored.restoredAt = new Date().toISOString();
  writeWorkspaceCleanupReports(restored);
  return restored;
}

export function readWorkspaceCleanupPlan(manifestPath: string): WorkspaceCleanupPlan {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8')) as WorkspaceCleanupPlan;
  if (parsed.schema !== 'codex-im-suite/workspace-cleanup/v1') throw new Error('不支持的清理清单协议');
  return parsed;
}
