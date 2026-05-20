#!/usr/bin/env node
import {
  restoreKnowledgeArchive,
} from './knowledge-archive.js';
import {
  applyMemoryOptimizationDraft,
  createMemoryOptimizationDraft,
  discardMemoryOptimizationDraft,
  readMemoryOptimizationStatus,
  undoMemoryOptimizationDraft,
  updateMemoryOptimizerSchedule,
  type MemoryOptimizerModelSource,
} from './memory-optimizer.js';

function readArg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1] || fallback;
}

function readBoolArg(name: string, fallback: boolean): boolean {
  const value = readArg(name, '');
  if (!value) return fallback;
  return value.toLowerCase() === 'true';
}

function readNumberArg(name: string, fallback: number): number {
  const value = Number.parseInt(readArg(name, ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

function readModelSource(value: string): MemoryOptimizerModelSource {
  return value === 'local_ai' || value === 'external_api' ? value : 'codex_primary';
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'status';
  const memoryRoot = readArg('--memory-root');
  if (!memoryRoot) throw new Error('Missing --memory-root');

  switch (command) {
    case 'status':
      writeJson(readMemoryOptimizationStatus(memoryRoot));
      return;
    case 'preview': {
      const draft = createMemoryOptimizationDraft(memoryRoot, {
        generatedBy: readArg('--generated-by') === 'schedule' ? 'schedule' : 'manual',
        modelSource: readModelSource(readArg('--model-source')),
      });
      writeJson({ ok: true, draft, status: readMemoryOptimizationStatus(memoryRoot) });
      return;
    }
    case 'apply': {
      const draftId = readArg('--draft-id');
      if (!draftId) throw new Error('Missing --draft-id');
      const selectedActionIds = readArg('--select')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const result = applyMemoryOptimizationDraft(memoryRoot, { draftId, selectedActionIds });
      writeJson({ ...result, status: readMemoryOptimizationStatus(memoryRoot) });
      return;
    }
    case 'undo': {
      const draftId = readArg('--draft-id');
      if (!draftId) throw new Error('Missing --draft-id');
      const result = undoMemoryOptimizationDraft(memoryRoot, draftId);
      writeJson({ ...result, status: readMemoryOptimizationStatus(memoryRoot) });
      return;
    }
    case 'restore-archive': {
      const archivePath = readArg('--archive-path');
      if (!archivePath) throw new Error('Missing --archive-path');
      const result = restoreKnowledgeArchive(memoryRoot, { archivePath });
      writeJson({ ...result, status: readMemoryOptimizationStatus(memoryRoot) });
      return;
    }
    case 'discard': {
      const draftId = readArg('--draft-id');
      if (!draftId) throw new Error('Missing --draft-id');
      const draft = discardMemoryOptimizationDraft(memoryRoot, draftId);
      writeJson({ ok: true, draft, status: readMemoryOptimizationStatus(memoryRoot) });
      return;
    }
    case 'schedule': {
      const state = updateMemoryOptimizerSchedule(memoryRoot, {
        enabled: readBoolArg('--enabled', false),
        intervalDays: readNumberArg('--interval-days', 7),
        modelSource: readModelSource(readArg('--model-source')),
      });
      writeJson({ ok: true, state, status: readMemoryOptimizationStatus(memoryRoot) });
      return;
    }
    default:
      throw new Error(`Unknown memory optimizer command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
