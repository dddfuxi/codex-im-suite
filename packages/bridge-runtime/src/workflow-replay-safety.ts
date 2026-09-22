import type { WorkflowReplaySafety } from '@codex-im-suite/contracts';

import { getExecutorCommandRisk } from './fast-path-intent.js';
import type { ExecutorRiskLevel } from './executor-types.js';

export interface WorkflowToolObservation {
  name: string;
  input?: unknown;
}

export interface WorkflowReplaySafetyDecision {
  replaySafety: WorkflowReplaySafety;
  reasonCode: string;
}

const EXPLICIT_READ_ONLY_TOOLS = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'view_image',
  'web__run',
]);

function readCommand(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : '';
}

function isExplicitlyReadOnlyTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (EXPLICIT_READ_ONLY_TOOLS.has(normalized)) return true;
  // MCP 工具没有统一运行时 Manifest 时，只接受名称中明确声明的查询动作；
  // 没有明确动作或未来新增的未知工具一律失败关闭，避免误把写操作当只读。
  return /(?:^|__)(?:get|list|read|search|find|query|inspect|describe)(?:_|$)/u.test(normalized);
}

function classifyTool(observation: WorkflowToolObservation): 'read_only' | 'mutating' | 'unknown' {
  const name = observation.name.trim().toLowerCase();
  if (!name) return 'unknown';
  if (name === 'shell_command' || name.endsWith('__shell_command')) {
    const command = readCommand(observation.input);
    if (!command) return 'unknown';
    const risk = getExecutorCommandRisk(command);
    return risk === 'read_only' ? 'read_only' : risk === 'mutating' ? 'mutating' : 'unknown';
  }
  if (name === 'apply_patch' || /(?:^|__)(?:create|update|delete|write|send|execute|run|edit|patch|promote)(?:_|$)/u.test(name)) {
    return 'mutating';
  }
  if (isExplicitlyReadOnlyTool(name)) return 'read_only';
  return 'unknown';
}

/**
 * 当前回合内 Provider 续跑的统一重放安全裁决。
 *
 * Executor Manifest 的 read_only 是可信运行上界；workspace_write/system 只表示
 * “可能写”，仍需逐个检查实际工具。任何无法证明为只读的未知工具默认禁止重放。
 */
export function decideWorkflowReplaySafety(input: {
  tools: readonly WorkflowToolObservation[];
  executorRiskLevel?: ExecutorRiskLevel;
}): WorkflowReplaySafetyDecision {
  if (input.tools.length === 0) {
    return { replaySafety: 'safe_no_tools', reasonCode: 'no_tools_observed' };
  }
  if (input.executorRiskLevel === 'read_only') {
    const hasExplicitMutation = input.tools.some((tool) => classifyTool(tool) === 'mutating');
    return hasExplicitMutation
      ? { replaySafety: 'unsafe_side_effects', reasonCode: 'read_only_manifest_conflict' }
      : { replaySafety: 'safe_read_only', reasonCode: 'read_only_executor_manifest' };
  }
  const classifications = input.tools.map(classifyTool);
  if (classifications.includes('mutating')) {
    return { replaySafety: 'unsafe_side_effects', reasonCode: 'mutating_tool_observed' };
  }
  if (classifications.includes('unknown')) {
    return { replaySafety: 'unsafe_unknown', reasonCode: 'unknown_tool_observed' };
  }
  return { replaySafety: 'safe_read_only', reasonCode: 'read_only_tools_observed' };
}

