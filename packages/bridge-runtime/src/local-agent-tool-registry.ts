import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpToolCallDefinition, ShellArtifactDefinition, UnityMcpExecuteCodeDefinition } from './local-agent-tool-protocol.js';

interface LocalAgentToolManifest {
  id?: string;
  enabled?: boolean;
  type?: string;
  displayName?: string;
  match?: {
    keywords?: string[];
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

function manifestDirs(): string[] {
  const dirs = [
    path.join(getSuiteRoot(), 'config', 'local-agent-tools.d'),
    path.join(RUNTIME_ROOT, 'config', 'local-agent-tools.d'),
    path.join(getCtiHome(), 'extensions', 'manifests', 'local-agent-tools.d'),
  ];
  const seen = new Set<string>();
  return dirs
    .map((dir) => path.resolve(dir))
    .filter((dir) => {
      const key = dir.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(dir);
    });
}

export function loadUnityMcpExecuteCodeDefinitions(): UnityMcpExecuteCodeDefinition[] {
  const definitions: UnityMcpExecuteCodeDefinition[] = [];
  for (const dir of manifestDirs()) {
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
      const fullPath = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as LocalAgentToolManifest;
        if (parsed.enabled === false) continue;
        if (parsed.type !== 'unity_mcp_execute_code') continue;
        const codeTemplate = parsed.unityMcp?.codeTemplate || '';
        if (!parsed.id || !codeTemplate.trim()) continue;
        definitions.push({
          id: parsed.id,
          displayName: parsed.displayName,
          match: parsed.match,
          codeTemplate,
          compiler: parsed.unityMcp?.compiler || 'auto',
          safety_checks: parsed.unityMcp?.safety_checks !== false,
        });
      } catch {
        continue;
      }
    }
  }
  return definitions;
}

export function loadMcpToolCallDefinitions(): McpToolCallDefinition[] {
  const definitions: McpToolCallDefinition[] = [];
  for (const dir of manifestDirs()) {
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
      const fullPath = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as LocalAgentToolManifest;
        if (parsed.enabled === false) continue;
        if (parsed.type !== 'mcp_tool_call') continue;
        const manifestHint = parsed.mcp?.manifestHint || '';
        const tool = parsed.mcp?.tool || '';
        if (!parsed.id || !manifestHint.trim() || !tool.trim()) continue;
        definitions.push({
          id: parsed.id,
          displayName: parsed.displayName,
          match: parsed.match,
          manifestHint,
          tool,
          arguments: parsed.mcp?.arguments || {},
        });
      } catch {
        continue;
      }
    }
  }
  return definitions;
}

export function loadShellArtifactDefinitions(): ShellArtifactDefinition[] {
  const definitions: ShellArtifactDefinition[] = [];
  for (const dir of manifestDirs()) {
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
      const fullPath = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as LocalAgentToolManifest;
        if (parsed.enabled === false) continue;
        if (parsed.type !== 'shell_artifact') continue;
        const command = parsed.shellArtifact?.command || '';
        const artifactPaths = Array.isArray(parsed.shellArtifact?.artifactPaths)
          ? parsed.shellArtifact.artifactPaths.filter((item): item is string => typeof item === 'string')
          : [];
        if (!parsed.id || !command.trim() || artifactPaths.length === 0) continue;
        definitions.push({
          id: parsed.id,
          displayName: parsed.displayName,
          match: parsed.match,
          command: expandManifestValue(command) || command,
          cwd: expandManifestValue(parsed.shellArtifact?.cwd),
          timeoutMs: parsed.shellArtifact?.timeoutMs,
          artifactPaths: expandManifestValues(artifactPaths),
        });
      } catch {
        continue;
      }
    }
  }
  return definitions;
}
