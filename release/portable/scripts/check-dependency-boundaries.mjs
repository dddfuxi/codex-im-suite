import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'release', '.git', '.worktrees', 'bin', 'obj', 'wwwroot']);
const IMPORT_RE = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/gu;

function normalize(value) {
  return path.resolve(value).replace(/\\/gu, '/').toLowerCase();
}

function listSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  };
  visit(path.join(root, 'packages'));
  visit(path.join(root, 'apps'));
  return files;
}

function extractImports(content) {
  return [...content.matchAll(IMPORT_RE)].map((match) => match[1]);
}

function resolveRelativeImport(sourceFile, specifier) {
  return specifier.startsWith('.') ? normalize(path.resolve(path.dirname(sourceFile), specifier)) : '';
}

function packageUnit(filePath) {
  const match = filePath.match(/\/(packages\/[^/]+|apps\/control-panel\/web)(?:\/|$)/u);
  return match?.[1] || '';
}

export function findDependencyBoundaryViolations(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const coreRoot = normalize(path.join(root, 'packages', 'bridge-core'));
  const runtimeRoot = normalize(path.join(root, 'packages', 'bridge-runtime'));
  const violations = [];
  for (const filePath of listSourceFiles(root)) {
    const normalizedFile = normalize(filePath);
    const sourceUnit = packageUnit(normalizedFile);
    const relativeFile = path.relative(root, filePath).replace(/\\/gu, '/');
    const content = fs.readFileSync(filePath, 'utf8');
    for (const specifier of extractImports(content)) {
      const resolvedImport = resolveRelativeImport(filePath, specifier);
      if (sourceUnit === 'apps/control-panel/web' && specifier === 'claude-to-im/policy') {
        violations.push({ rule: 'web-browser-safe-core-entry', file: relativeFile, import: specifier });
        continue;
      }
      if (/^(?:claude-to-im|@codex-im-suite\/[^/]+)\/src\//u.test(specifier)) {
        violations.push({ rule: 'no-deep-package-import', file: relativeFile, import: specifier });
        continue;
      }
      if (normalizedFile.startsWith(`${coreRoot}/`)
        && (specifier === 'claude-to-im-skill'
          || specifier.startsWith('claude-to-im-skill/')
          || resolvedImport.startsWith(`${runtimeRoot}/`))) {
        violations.push({ rule: 'bridge-core-no-runtime-dependency', file: relativeFile, import: specifier });
        continue;
      }
      const targetUnit = packageUnit(resolvedImport);
      if (resolvedImport && resolvedImport.includes('/src/') && sourceUnit && targetUnit && sourceUnit !== targetUnit) {
        violations.push({ rule: 'no-cross-package-source-import', file: relativeFile, import: specifier });
      }
    }
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file) || left.import.localeCompare(right.import));
}

function flattenExportTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenExportTargets);
}

export function findPackageExportViolations(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const packagePath = path.join(root, 'packages', 'bridge-core', 'package.json');
  if (!fs.existsSync(packagePath)) return [];
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const violations = [];
  for (const [exportName, target] of Object.entries(packageJson.exports || {})) {
    if (exportName.includes('/src/') || flattenExportTargets(target).some((item) => item.includes('/src/'))) {
      violations.push({
        rule: 'package-exports-no-source-internals',
        file: 'packages/bridge-core/package.json',
        import: exportName,
      });
    }
  }
  for (const publishedPath of packageJson.files || []) {
    if (publishedPath === 'src' || publishedPath.startsWith('src/')) {
      violations.push({
        rule: 'package-files-no-source-internals',
        file: 'packages/bridge-core/package.json',
        import: publishedPath,
      });
    }
  }
  return violations;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const violations = [
    ...findDependencyBoundaryViolations(root),
    ...findPackageExportViolations(root),
  ];
  if (violations.length === 0) {
    console.log('Dependency boundaries: OK');
  } else {
    console.error(`Dependency boundaries: FAILED (${violations.length})`);
    for (const violation of violations) {
      console.error(`- [${violation.rule}] ${violation.file}: ${violation.import}`);
    }
    process.exitCode = 1;
  }
}
