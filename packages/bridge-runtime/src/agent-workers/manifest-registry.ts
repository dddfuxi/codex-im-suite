import fs from 'node:fs';
import path from 'node:path';

import type { CollaborationAgentManifest } from '@codex-im-suite/contracts';

export interface AgentManifestRegistry {
  manifestDir: string;
  manifests: CollaborationAgentManifest[];
  byId: Map<string, CollaborationAgentManifest>;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function validateAgentManifest(value: unknown): CollaborationAgentManifest | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const responsibilities = stringList(source.responsibilities);
  const owns = stringList(source.owns);
  const excludes = stringList(source.excludes);
  const capabilities = stringList(source.capabilities);
  const inputEvidenceKinds = stringList(source.inputEvidenceKinds);
  if (
    source.protocol !== 'codex-im-suite/agent-collaboration/v1'
    || typeof source.id !== 'string'
    || !source.id.trim()
    || typeof source.displayName !== 'string'
    || !source.displayName.trim()
    || typeof source.enabled !== 'boolean'
    || !responsibilities
    || !owns
    || !excludes
    || !capabilities?.length
    || !inputEvidenceKinds
    || typeof source.outputSchemaId !== 'string'
    || !source.outputSchemaId.trim()
    || source.sideEffectLevel !== 'none'
    || typeof source.timeoutMs !== 'number'
    || !Number.isFinite(source.timeoutMs)
    || source.timeoutMs < 1
    || typeof source.concurrency !== 'number'
    || !Number.isFinite(source.concurrency)
    || source.concurrency < 1
    || typeof source.modelProfile !== 'string'
    || !source.modelProfile.trim()
  ) return null;
  return {
    protocol: 'codex-im-suite/agent-collaboration/v1',
    id: source.id.trim(),
    displayName: source.displayName.trim(),
    enabled: source.enabled,
    responsibilities,
    owns,
    excludes,
    capabilities,
    inputEvidenceKinds,
    outputSchemaId: source.outputSchemaId.trim(),
    sideEffectLevel: 'none',
    timeoutMs: Math.floor(source.timeoutMs),
    concurrency: Math.floor(source.concurrency),
    modelProfile: source.modelProfile.trim(),
  };
}

export function loadAgentManifestRegistry(manifestDir: string): AgentManifestRegistry {
  const resolvedDir = path.resolve(manifestDir);
  const manifests: CollaborationAgentManifest[] = [];
  if (fs.existsSync(resolvedDir)) {
    for (const fileName of fs.readdirSync(resolvedDir).filter((item) => item.toLowerCase().endsWith('.json')).sort()) {
      const filePath = path.join(resolvedDir, fileName);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      const manifest = validateAgentManifest(parsed);
      if (!manifest) throw new Error(`无效 Agent Manifest：${filePath}`);
      manifests.push(manifest);
    }
  }
  const byId = new Map<string, CollaborationAgentManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) throw new Error(`Agent Manifest ID 重复：${manifest.id}`);
    byId.set(manifest.id, manifest);
  }
  return { manifestDir: resolvedDir, manifests, byId };
}
