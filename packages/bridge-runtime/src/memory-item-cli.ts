import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryItemLifecycleService } from './memory-items/lifecycle.js';
import {
  applyMemoryCandidateMigrationPlan,
  buildMemoryCandidateMigrationPlan,
  type MemoryCandidateMigrationPlan,
} from './memory-items/migration.js';

export interface MemoryItemCliResult {
  ok: true;
  // CLI 是控制面板与人工诊断的 JSON 边界；各命令保留自身稳定 DTO。
  data: any;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
}

const ITEM_ID_RE = /^[a-f0-9]{64}$/u;
const VALUE_OPTIONS = new Set([
  '--memory-root',
  '--expected-base-hash',
  '--key',
  '--ids-base64',
  '--output',
  '--manifest',
]);

function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) throw new Error(`unknown_option: ${argument}`);
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith('--')) throw new Error(`missing_option_value: ${argument}`);
    if (options.has(argument)) throw new Error(`duplicate_option: ${argument}`);
    options.set(argument, value);
    index += 1;
  }
  return { positionals, options };
}

function requireMemoryRoot(options: Map<string, string>): string {
  const memoryRoot = options.get('--memory-root') || process.env.CTI_MEMORY_REPO_DIR?.trim();
  if (!memoryRoot) throw new Error('memory_root_required');
  return path.resolve(memoryRoot);
}

function requireOpaqueId(value: string | undefined, kind: 'item' | 'archive'): string {
  if (!value || !ITEM_ID_RE.test(value)) throw new Error(kind === 'archive' ? 'invalid_archive_id' : 'invalid_item_id');
  return value;
}

function optionalBaseHash(options: Map<string, string>): string | undefined {
  const value = options.get('--expected-base-hash');
  if (value && !ITEM_ID_RE.test(value)) throw new Error('invalid_expected_base_hash');
  return value;
}

function optionalMemoryKey(options: Map<string, string>): string | undefined {
  const value = options.get('--key')?.trim();
  if (!value) return undefined;
  if (value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid_memory_key');
  return value;
}

function decodeReviewedIds(encoded: string | undefined): string[] {
  if (!encoded) throw new Error('ids_base64_required');
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 500) throw new Error('invalid');
    const ids = [...new Set(parsed.map((value) => requireOpaqueId(typeof value === 'string' ? value : undefined, 'item')))];
    if (ids.length !== parsed.length) throw new Error('duplicate');
    return ids;
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_item_id') throw error;
    throw new Error('invalid_ids_base64');
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function readMigrationManifest(filePath: string): MemoryCandidateMigrationPlan {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as MemoryCandidateMigrationPlan;
    if (parsed.schema !== 'codex-im-suite/memory-candidate-migration/v1') throw new Error('invalid_migration_manifest');
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_migration_manifest') throw error;
    throw new Error('invalid_migration_manifest');
  }
}

export function runMemoryItemCli(argv: string[]): MemoryItemCliResult {
  const parsed = parseArguments(argv);
  const [command = 'status', target, extra] = parsed.positionals;
  if (extra) throw new Error('unexpected_positional_argument');
  const memoryRoot = requireMemoryRoot(parsed.options);
  const service = createMemoryItemLifecycleService({ memoryRoot });

  switch (command) {
    case 'status': {
      if (target) throw new Error('unexpected_positional_argument');
      const confirmedCount = service.listConfirmed().length;
      const candidateCount = service.listCandidates().length;
      const archivedCount = service.listArchives().length;
      return { ok: true, data: { memoryRoot, confirmedCount, candidateCount, archivedCount } };
    }
    case 'list-confirmed': {
      if (target) throw new Error('unexpected_positional_argument');
      const items = service.listConfirmed();
      return { ok: true, data: { items, count: items.length } };
    }
    case 'list-candidates': {
      if (target) throw new Error('unexpected_positional_argument');
      const items = service.listCandidates();
      return { ok: true, data: { items, count: items.length } };
    }
    case 'list-archives': {
      if (target) throw new Error('unexpected_positional_argument');
      const items = service.listArchives();
      return { ok: true, data: { items, count: items.length } };
    }
    case 'confirm':
      return {
        ok: true,
        data: service.confirmCandidate(requireOpaqueId(target, 'item'), 'control-panel', {
          expectedBaseHash: optionalBaseHash(parsed.options),
          key: optionalMemoryKey(parsed.options),
        }),
      };
    case 'archive':
      return {
        ok: true,
        data: service.archive(requireOpaqueId(target, 'item'), 'control-panel', {
          expectedBaseHash: optionalBaseHash(parsed.options),
        }),
      };
    case 'restore':
      return { ok: true, data: service.restore(requireOpaqueId(target, 'archive'), 'control-panel') };
    case 'delete-archive':
      return { ok: true, data: service.deleteArchive(requireOpaqueId(target, 'archive'), 'control-panel') };
    case 'archive-candidates': {
      if (target) throw new Error('unexpected_positional_argument');
      const ids = decodeReviewedIds(parsed.options.get('--ids-base64'));
      const candidates = new Map(service.listCandidates().map((item) => [item.itemId, item]));
      for (const id of ids) {
        if (!candidates.has(id)) throw new Error(`candidate_not_found: ${id}`);
      }
      const archived = ids.map((id) => {
        // 前一项可能与当前项位于同一 Markdown；每次重新读取 baseHash，避免批量操作自冲突。
        const current = service.listCandidates().find((item) => item.itemId === id);
        if (!current) throw new Error(`candidate_not_found: ${id}`);
        return service.archive(id, 'control-panel', { expectedBaseHash: current.sourceBaseHash });
      });
      return { ok: true, data: { archived, count: archived.length } };
    }
    case 'migrate': {
      if (target === 'preview') {
        const plan = buildMemoryCandidateMigrationPlan({ memoryRoot });
        const output = parsed.options.get('--output');
        if (!output) throw new Error('migration_output_required');
        writeJsonAtomic(output, plan);
        return { ok: true, data: { plan, output: path.resolve(output) } };
      }
      if (target === 'apply') {
        const manifestPath = parsed.options.get('--manifest');
        if (!manifestPath) throw new Error('migration_manifest_required');
        const plan = readMigrationManifest(manifestPath);
        if (path.resolve(plan.memoryRoot) !== memoryRoot) throw new Error('migration_memory_root_mismatch');
        return { ok: true, data: applyMemoryCandidateMigrationPlan(plan) };
      }
      throw new Error('unknown_migration_command');
    }
    default:
      throw new Error(`unknown_command: ${command}`);
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entryPath === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  try {
    const result = runMemoryItemCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
