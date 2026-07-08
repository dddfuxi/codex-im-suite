import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpToolCallDefinition, ShellArtifactDefinition, UnityMcpExecuteCodeDefinition } from './local-agent-tool-protocol.js';

interface LocalAgentToolManifest {
  id?: string;
  enabled?: boolean;
  type?: string;
  compatibility?: {
    protocol?: string;
    suite?: string;
  };
  displayName?: string;
  match?: {
    keywords?: string[];
    keywordGroups?: string[][];
    regex?: string[];
    contextualRegex?: string[];
    contextRegex?: string[];
  };
  unityMcp?: {
    tool?: string;
    codeTemplate?: string;
    compiler?: 'auto' | 'roslyn' | 'codedom';
    safety_checks?: boolean;
  };
  mcp?: {
    manifestHint?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  };
  shellArtifact?: {
    command?: string;
    cwd?: string;
    timeoutMs?: number;
    artifactPaths?: string[];
  };
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(MODULE_DIR, '..');
const ACTION_MANIFEST_PROTOCOL = 'action-manifest/v1';
const SUPPORTED_LOCAL_AGENT_TOOL_TYPES = new Set(['unity_mcp_execute_code', 'mcp_tool_call', 'shell_artifact']);
const emittedDiagnosticKeys = new Set<string>();

export interface LocalAgentToolManifestDiagnostic {
  filePath: string;
  severity: 'warning';
  message: string;
}

type ActionManifestDirectoryKind = 'action' | 'legacy-local-agent';

interface ActionManifestDirectory {
  path: string;
  kind: ActionManifestDirectoryKind;
  priority: number;
}

function getSuiteRoot(): string {
  const candidates = [
    process.env.CODEX_IM_SUITE_ROOT || '',
    path.join(os.homedir(), 'Documents', 'New project', 'codex-im-suite'),
    path.resolve(RUNTIME_ROOT, '..', '..'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'suite.manifest.json'))) return path.resolve(candidate);
  }
  return path.resolve(RUNTIME_ROOT, '..', '..');
}

function getCtiHome(): string {
  return process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
}

function expandManifestValue(value: string | undefined): string | undefined {
  if (!value) return value;
  const replacements: Record<string, string> = {
    CTI_HOME: getCtiHome(),
    SUITE_ROOT: getSuiteRoot(),
    RUNTIME_ROOT,
    USERPROFILE: os.homedir(),
  };
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => replacements[name] || match);
}

function expandManifestValues(values: string[]): string[] {
  return values.map((value) => expandManifestValue(value) || value);
}

function manifestDirs(): ActionManifestDirectory[] {
  const dirs = [
    { path: path.join(getSuiteRoot(), 'config', 'action-manifests.d'), kind: 'action' as const, priority: 100 },
    { path: path.join(RUNTIME_ROOT, 'config', 'action-manifests.d'), kind: 'action' as const, priority: 110 },
    { path: path.join(getCtiHome(), 'extensions', 'manifests', 'action-manifests.d'), kind: 'action' as const, priority: 120 },
    { path: path.join(getSuiteRoot(), 'config', 'local-agent-tools.d'), kind: 'legacy-local-agent' as const, priority: 10 },
    { path: path.join(RUNTIME_ROOT, 'config', 'local-agent-tools.d'), kind: 'legacy-local-agent' as const, priority: 20 },
    { path: path.join(getCtiHome(), 'extensions', 'manifests', 'local-agent-tools.d'), kind: 'legacy-local-agent' as const, priority: 30 },
  ];
  const seen = new Set<string>();
  return dirs
    .map((entry) => ({ ...entry, path: path.resolve(entry.path) }))
    .filter((entry) => {
      const key = entry.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(entry.path);
    });
}

function createDiagnostic(filePath: string, message: string): LocalAgentToolManifestDiagnostic {
  return { filePath, severity: 'warning', message };
}

function validateRegexList(
  filePath: string,
  fieldName: string,
  values: unknown,
  diagnostics: LocalAgentToolManifestDiagnostic[],
): void {
  if (values === undefined) return;
  if (!Array.isArray(values)) {
    diagnostics.push(createDiagnostic(filePath, `${fieldName} must be an array`));
    return;
  }
  for (const value of values) {
    if (typeof value !== 'string') {
      diagnostics.push(createDiagnostic(filePath, `${fieldName} entries must be strings`));
      continue;
    }
    try {
      new RegExp(value, 'iu');
    } catch (error) {
      diagnostics.push(createDiagnostic(
        filePath,
        `invalid ${fieldName} regex: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }
}

function validateLocalAgentToolManifest(
  parsed: unknown,
  filePath: string,
  directoryKind: ActionManifestDirectoryKind,
): { manifest?: LocalAgentToolManifest; diagnostics: LocalAgentToolManifestDiagnostic[] } {
  const diagnostics: LocalAgentToolManifestDiagnostic[] = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push(createDiagnostic(filePath, 'action manifest must be an object'));
    return { diagnostics };
  }

  const manifest = parsed as LocalAgentToolManifest;
  if (!manifest.id?.trim()) {
    diagnostics.push(createDiagnostic(filePath, 'action manifest is missing id'));
  }
  if (directoryKind === 'action') {
    const protocol = manifest.compatibility?.protocol?.trim() || '';
    if (protocol !== ACTION_MANIFEST_PROTOCOL) {
      diagnostics.push(createDiagnostic(
        filePath,
        `action manifest compatibility.protocol must be ${ACTION_MANIFEST_PROTOCOL}`,
      ));
    }
  }
  if (manifest.enabled === false) return { manifest, diagnostics };

  const type = manifest.type?.trim() || '';
  if (!SUPPORTED_LOCAL_AGENT_TOOL_TYPES.has(type)) {
    diagnostics.push(createDiagnostic(filePath, `action manifest has unsupported type: ${type || '(empty)'}`));
    return { manifest, diagnostics };
  }

  const match = manifest.match && typeof manifest.match === 'object' && !Array.isArray(manifest.match)
    ? manifest.match as Record<string, unknown>
    : {};
  validateRegexList(filePath, 'match.regex', match.regex, diagnostics);
  validateRegexList(filePath, 'match.contextualRegex', match.contextualRegex, diagnostics);
  validateRegexList(filePath, 'match.contextRegex', match.contextRegex, diagnostics);

  if (type === 'unity_mcp_execute_code' && !manifest.unityMcp?.codeTemplate?.trim()) {
    diagnostics.push(createDiagnostic(filePath, 'unity_mcp_execute_code manifest is missing unityMcp.codeTemplate'));
  }
  if (type === 'mcp_tool_call') {
    if (!manifest.mcp?.manifestHint?.trim() || !manifest.mcp?.tool?.trim()) {
      diagnostics.push(createDiagnostic(filePath, 'mcp_tool_call manifest is missing mcp.manifestHint or mcp.tool'));
    }
  }
  if (type === 'shell_artifact') {
    const artifactPaths = Array.isArray(manifest.shellArtifact?.artifactPaths)
      ? manifest.shellArtifact.artifactPaths.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : [];
    if (!manifest.shellArtifact?.command?.trim()) {
      diagnostics.push(createDiagnostic(filePath, 'shell_artifact manifest is missing shellArtifact.command'));
    }
    if (artifactPaths.length === 0) {
      diagnostics.push(createDiagnostic(filePath, 'shell_artifact manifest is missing shellArtifact.artifactPaths'));
    }
  }

  return { manifest, diagnostics };
}

function loadLocalAgentToolManifestEntries(options: { emitDiagnostics?: boolean } = {}): {
  manifests: Array<{ filePath: string; manifest: LocalAgentToolManifest }>;
  diagnostics: LocalAgentToolManifestDiagnostic[];
} {
  // action-manifests.d 是新的通用动作入口；旧 local-agent-tools.d 只作为兼容层读取。
  // 坏 manifest 必须进入诊断，而不能像旧逻辑一样静默消失。
  const manifestsById = new Map<string, { filePath: string; manifest: LocalAgentToolManifest; priority: number }>();
  const diagnostics: LocalAgentToolManifestDiagnostic[] = [];
  for (const dir of manifestDirs()) {
    for (const name of fs.readdirSync(dir.path).filter((item) => item.endsWith('.json')).sort()) {
      const filePath = path.join(dir.path, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
        const validation = validateLocalAgentToolManifest(parsed, filePath, dir.kind);
        diagnostics.push(...validation.diagnostics);
        if (validation.manifest && validation.manifest.enabled !== false && validation.diagnostics.length === 0) {
          const idKey = validation.manifest.id!.trim().toLowerCase();
          const previous = manifestsById.get(idKey);
          if (previous && previous.priority >= dir.priority) {
            diagnostics.push(createDiagnostic(
              filePath,
              `duplicate action manifest id '${validation.manifest.id}' ignored; selected definition: ${previous.filePath}`,
            ));
            continue;
          }
          if (previous) {
            diagnostics.push(createDiagnostic(
              filePath,
              `overrides previous action manifest id '${validation.manifest.id}'; previous definition: ${previous.filePath}`,
            ));
          }
          manifestsById.set(idKey, { filePath, manifest: validation.manifest, priority: dir.priority });
        }
      } catch (error) {
        diagnostics.push(createDiagnostic(
          filePath,
          `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }
  if (options.emitDiagnostics) emitLocalAgentToolManifestDiagnostics(diagnostics);
  return {
    manifests: Array.from(manifestsById.values()).map(({ filePath, manifest }) => ({ filePath, manifest })),
    diagnostics,
  };
}

function emitLocalAgentToolManifestDiagnostics(diagnostics: LocalAgentToolManifestDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.filePath}\0${diagnostic.message}`;
    if (emittedDiagnosticKeys.has(key)) continue;
    emittedDiagnosticKeys.add(key);
    console.warn(`[action-manifests] ${diagnostic.filePath}: ${diagnostic.message}`);
  }
}

export function loadLocalAgentToolManifestDiagnostics(): LocalAgentToolManifestDiagnostic[] {
  return loadLocalAgentToolManifestEntries().diagnostics;
}

export function loadUnityMcpExecuteCodeDefinitions(): UnityMcpExecuteCodeDefinition[] {
  const definitions: UnityMcpExecuteCodeDefinition[] = [];
  for (const { manifest: parsed } of loadLocalAgentToolManifestEntries({ emitDiagnostics: true }).manifests) {
    if (parsed.enabled === false) continue;
    if (parsed.type !== 'unity_mcp_execute_code') continue;
    const codeTemplate = parsed.unityMcp?.codeTemplate || '';
    definitions.push({
      id: parsed.id!,
      displayName: parsed.displayName,
      match: parsed.match,
      codeTemplate,
      compiler: parsed.unityMcp?.compiler || 'auto',
      safety_checks: parsed.unityMcp?.safety_checks !== false,
    });
  }
  return definitions;
}

export function loadMcpToolCallDefinitions(): McpToolCallDefinition[] {
  const definitions: McpToolCallDefinition[] = [];
  for (const { manifest: parsed } of loadLocalAgentToolManifestEntries({ emitDiagnostics: true }).manifests) {
    if (parsed.enabled === false) continue;
    if (parsed.type !== 'mcp_tool_call') continue;
    definitions.push({
      id: parsed.id!,
      displayName: parsed.displayName,
      match: parsed.match,
      manifestHint: parsed.mcp!.manifestHint!,
      tool: parsed.mcp!.tool!,
      arguments: parsed.mcp?.arguments || {},
    });
  }
  return definitions;
}

export function loadShellArtifactDefinitions(): ShellArtifactDefinition[] {
  const definitions: ShellArtifactDefinition[] = [];
  for (const { manifest: parsed } of loadLocalAgentToolManifestEntries({ emitDiagnostics: true }).manifests) {
    if (parsed.enabled === false) continue;
    if (parsed.type !== 'shell_artifact') continue;
    const command = parsed.shellArtifact!.command!;
    const artifactPaths = parsed.shellArtifact!.artifactPaths!.filter((item): item is string => typeof item === 'string');
    definitions.push({
      id: parsed.id!,
      displayName: parsed.displayName,
      match: parsed.match,
      command: expandManifestValue(command) || command,
      cwd: expandManifestValue(parsed.shellArtifact?.cwd),
      timeoutMs: parsed.shellArtifact?.timeoutMs,
      artifactPaths: expandManifestValues(artifactPaths),
    });
  }
  return definitions;
}
