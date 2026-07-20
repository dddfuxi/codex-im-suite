import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStickerSemanticStore, type StickerManualSemanticPatch } from './sticker-semantics/store.js';

export interface StickerSemanticCliResult {
  ok: true;
  data: any;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
}

const VALUE_OPTIONS = new Set([
  '--memory-root',
  '--status',
  '--scope',
  '--scope-id',
  '--expected-base-hash',
  '--payload-base64',
  '--output',
  '--manifest',
]);
const HASH_RE = /^[a-f0-9]{64}$/u;
const FILE_KEY_RE = /^[A-Za-z0-9._:-]{1,256}$/u;
const REVISION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/u;

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
  const root = options.get('--memory-root') || process.env.CTI_MEMORY_REPO_DIR?.trim();
  if (!root) throw new Error('memory_root_required');
  return path.resolve(root);
}

function requireBaseHash(options: Map<string, string>): string {
  const value = options.get('--expected-base-hash');
  if (!value) throw new Error('expected_base_hash_required');
  if (!HASH_RE.test(value)) throw new Error('invalid_expected_base_hash');
  return value;
}

function requireFileKey(value: string | undefined): string {
  if (!value || !FILE_KEY_RE.test(value)) throw new Error('invalid_file_key');
  return value;
}

function requireRevisionId(value: string | undefined): string {
  if (!value || !REVISION_ID_RE.test(value)) throw new Error('invalid_revision_id');
  return value;
}

function decodePatch(encoded: string | undefined): StickerManualSemanticPatch {
  if (!encoded) throw new Error('payload_base64_required');
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { throw new Error('invalid_payload_base64'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_manual_payload');
  const record = payload as Record<string, unknown>;
  const allowed = new Set(['label', 'description', 'intent', 'tone', 'usage', 'aliases', 'examples', 'avoidWhen', 'avoidRules', 'disabled', 'disabledReason']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('invalid_manual_payload_field');
  return record as StickerManualSemanticPatch;
}

function counts(revisions: Array<{ status: string }>): Record<string, number> {
  return revisions.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, { trial: 0, confirmed: 0, regressed: 0, rejected: 0 } as Record<string, number>);
}

export function runStickerSemanticCli(argv: string[]): StickerSemanticCliResult {
  const parsed = parseArguments(argv);
  const [command = 'status', target, extra] = parsed.positionals;
  if (extra) throw new Error('unexpected_positional_argument');
  const memoryRoot = requireMemoryRoot(parsed.options);
  const store = createStickerSemanticStore({ memoryRoot });

  switch (command) {
    case 'status': {
      if (target) throw new Error('unexpected_positional_argument');
      const snapshot = store.readSnapshot();
      const humanArchivePath = path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers', '表情包语义档案.md');
      return {
        ok: true,
        data: {
          memoryRoot,
          baseHash: snapshot.baseHash,
          generatedAt: snapshot.generatedAt,
          assetCount: snapshot.assets.length,
          counts: counts(snapshot.revisions),
          humanArchivePath,
          humanArchiveExists: fs.existsSync(humanArchivePath),
        },
      };
    }
    case 'list': {
      if (target) throw new Error('unexpected_positional_argument');
      const snapshot = store.readSnapshot();
      const status = parsed.options.get('--status');
      if (status && !['trial', 'confirmed', 'regressed', 'rejected'].includes(status)) throw new Error('invalid_status');
      const revisions = status ? snapshot.revisions.filter((item) => item.status === status) : snapshot.revisions;
      return { ok: true, data: { snapshot: { ...snapshot, revisions }, revisions, assets: snapshot.assets, counts: counts(snapshot.revisions) } };
    }
    case 'history': {
      const fileKey = requireFileKey(target);
      const snapshot = store.readSnapshot();
      const scope = parsed.options.get('--scope');
      const scopeId = parsed.options.get('--scope-id');
      const revisions = snapshot.revisions
        .filter((item) => item.fileKey === fileKey)
        .filter((item) => !scope || item.scope === scope)
        .filter((item) => !scopeId || item.scopeId === scopeId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { ok: true, data: { fileKey, baseHash: snapshot.baseHash, revisions } };
    }
    case 'accept-revision': {
      const revision = store.setRevisionStatus({ revisionId: requireRevisionId(target), status: 'confirmed', expectedBaseHash: requireBaseHash(parsed.options), actor: 'control-panel' });
      return { ok: true, data: { revision, baseHash: store.readSnapshot().baseHash } };
    }
    case 'reject-revision': {
      const revision = store.setRevisionStatus({ revisionId: requireRevisionId(target), status: 'rejected', expectedBaseHash: requireBaseHash(parsed.options), actor: 'control-panel' });
      return { ok: true, data: { revision, baseHash: store.readSnapshot().baseHash } };
    }
    case 'rollback': {
      const revision = store.setRevisionStatus({ revisionId: requireRevisionId(target), status: 'regressed', expectedBaseHash: requireBaseHash(parsed.options), actor: 'control-panel' });
      return { ok: true, data: { revision, baseHash: store.readSnapshot().baseHash } };
    }
    case 'update-manual': {
      const result = store.updateManual({
        fileKey: requireFileKey(target),
        patch: decodePatch(parsed.options.get('--payload-base64')),
        expectedBaseHash: requireBaseHash(parsed.options),
        actor: 'control-panel',
      });
      return { ok: true, data: result };
    }
    case 'archive': {
      const snapshot = store.setArchived({ fileKey: requireFileKey(target), archived: true, expectedBaseHash: requireBaseHash(parsed.options), actor: 'control-panel' });
      return { ok: true, data: { snapshot } };
    }
    case 'restore': {
      const snapshot = store.setArchived({ fileKey: requireFileKey(target), archived: false, expectedBaseHash: requireBaseHash(parsed.options), actor: 'control-panel' });
      return { ok: true, data: { snapshot } };
    }
    case 'delete-archived': {
      const snapshot = store.deleteArchived({ fileKey: requireFileKey(target), expectedBaseHash: requireBaseHash(parsed.options), actor: 'control-panel' });
      return { ok: true, data: { snapshot } };
    }
    case 'migrate':
      throw new Error('migration_not_implemented');
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
    process.stdout.write(`${JSON.stringify(runStickerSemanticCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
