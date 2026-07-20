import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEVELOPMENT_LOG = 'docs/DEVELOPMENT-LOG.md';
const ARCHITECTURE_DOC = 'docs/PROJECT-ARCHITECTURE.md';

function normalize(file) {
  return String(file || '').trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function isTestOnly(file) {
  return /(?:^|\/)(?:__tests__|ControlPanel\.Tests)(?:\/|$)/u.test(file)
    || /(?:\.test|Tests)\.(?:ts|tsx|js|mjs|cs)$/u.test(file);
}

function isRelevantSource(file) {
  if (!file || isTestOnly(file)) return false;
  return /^(?:packages\/[^/]+\/src\/|apps\/control-panel\/|config\/(?:action-manifests|mcp|plugins|runtime|skills)\.d\/|scripts\/|suite\.manifest\.json$)/u.test(file)
    && !/(?:^|\/)(?:bin|obj|dist|release)(?:\/|$)/u.test(file)
    && !file.startsWith('docs/');
}

function isArchitectureSensitive(file) {
  if (!isRelevantSource(file)) return false;
  return /^(?:packages\/(?:contracts|bridge-core|bridge-runtime)\/src\/|apps\/control-panel\/|config\/mcp\.d\/|suite\.manifest\.json$|scripts\/(?:build|assemble|package|publish|sync|register|bootstrap))/u.test(file);
}

export function assessHumanDocumentationChanges(inputFiles) {
  const files = [...new Set(inputFiles.map(normalize).filter(Boolean))].sort();
  const relevantChange = files.some(isRelevantSource);
  const architectureChange = files.some(isArchitectureSensitive);
  const missing = [];
  if (relevantChange && !files.includes(DEVELOPMENT_LOG)) missing.push(DEVELOPMENT_LOG);
  if (architectureChange && !files.includes(ARCHITECTURE_DOC)) missing.push(ARCHITECTURE_DOC);
  return {
    ok: missing.length === 0,
    files,
    relevantChange,
    architectureChange,
    missing,
  };
}

function gitLines(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .split(/\r?\n/gu)
      .map(normalize)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function collectWorkingTreeChanges() {
  return [...new Set([
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMR']),
    ...gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])];
}

function main() {
  const result = assessHumanDocumentationChanges(collectWorkingTreeChanges());
  console.log('人类文档同步门禁');
  console.log(`相关实现变化：${result.relevantChange ? '是' : '否'}`);
  console.log(`架构敏感变化：${result.architectureChange ? '是' : '否'}`);
  if (result.ok) {
    console.log('结果：通过');
    return;
  }
  console.error('结果：失败，以下人类阅读入口尚未随实现更新：');
  for (const file of result.missing) console.error(`  - ${file}`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
