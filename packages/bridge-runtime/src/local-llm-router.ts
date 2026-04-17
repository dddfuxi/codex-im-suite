import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from './config.js';
import type { LocalRouterMode } from './local-llm-status.js';

export type LocalRouterDecisionType = 'answer_local' | 'escalate_codex' | 'refuse_local';
export type LocalTaskKind =
  | 'chat'
  | 'explain'
  | 'summarize'
  | 'config_help'
  | 'command_draft'
  | 'script_draft'
  | 'code_explain'
  | 'tool_request'
  | 'repo_query'
  | 'unity_like'
  | 'blender_like'
  | 'doc_like';

export interface LocalRouteProtocolResult {
  decision: LocalRouterDecisionType;
  taskKind: LocalTaskKind;
  reason: string;
  needsCodex: boolean;
  canAnswerLocally: boolean;
  compressedPrompt: string;
  compressedHistory: string;
  suggestedReplyMode: string;
  safetyFlags: string[];
}

export interface ConservativeRouteDecision {
  useLocal: boolean;
  requestKind: LocalTaskKind;
  reason: string;
  highRisk: boolean;
  readOnlyDraftOnly: boolean;
  preferredDecision: LocalRouterDecisionType;
  compressedPrompt: string;
  compressedHistory: string;
  executionIntent: boolean;
  canFastPath: boolean;
}

interface PatternRule {
  pattern: RegExp;
  reason: string;
  taskKind?: LocalTaskKind;
}

const DEFAULT_MAX_INPUT_CHARS = 6000;
const DEFAULT_ROUTER_HISTORY_ITEMS = 6;
const DEFAULT_ROUTER_PROMPT_CHARS = 2200;
const DEFAULT_ROUTER_HISTORY_CHARS = 2600;
const MAX_HISTORY_ENTRY_CHARS = 320;

const HARD_EXCLUDE_PATTERNS: PatternRule[] = [
  { pattern: /\b(unity|timeline|prefab|mcp for unity|unity mcp)\b/i, reason: '涉及 Unity 或 Unity MCP', taskKind: 'unity_like' },
  { pattern: /\b(blender|blender mcp|glb|gltf)\b/i, reason: '涉及 Blender 或 3D 资产链路', taskKind: 'blender_like' },
  { pattern: /(飞书文档|feishu doc|docx|lark doc|云文档)/i, reason: '涉及飞书文档操作', taskKind: 'doc_like' },
  { pattern: /(截图|图片|image|附件|发图|上传图片|标注图)/i, reason: '涉及图片或附件处理', taskKind: 'tool_request' },
  { pattern: /\b(git\s+(push|rebase|merge|reset|checkout|switch|cherry-pick|clean|stash(?:\s+(?:pop|apply))?|commit)|publish|pull request)\b/i, reason: '涉及高风险仓库写操作或发布', taskKind: 'repo_query' },
  { pattern: /(删库|清空会话|重置桥接|修改桥接配置|删除飞书文档|永久删除)/i, reason: '涉及高风险删除或桥接配置修改', taskKind: 'tool_request' },
  { pattern: /(创建飞书文档|删除飞书文档|发送到其他群|跨群转发)/i, reason: '涉及外部平台真实操作', taskKind: 'tool_request' },
];

const LOCAL_FRIENDLY_PATTERNS: PatternRule[] = [
  { pattern: /(解释这条错误|解释报错|报错是什么意思|日志总结|帮我总结这段日志|总结日志|错误分类)/i, reason: '日志总结或错误解释', taskKind: 'summarize' },
  { pattern: /\b(json|yaml|yml|toml|env)\b|配置文件|配置项/i, reason: '配置解释请求', taskKind: 'config_help' },
  { pattern: /(解释这段代码|解释这个函数|这段函数在做什么|代码片段解释|轻量重写)/i, reason: '代码解释请求', taskKind: 'code_explain' },
  { pattern: /(写一个.*脚本|生成.*脚本|小脚本|模板脚本|单文件脚本)/i, reason: '脚本草案请求', taskKind: 'script_draft' },
  { pattern: /(给我一条.*命令|只返回命令|怎么查|如何查看|ahead|behind|落后几条|领先几条|没拉几条)/i, reason: '只读命令草案请求', taskKind: 'command_draft' },
  { pattern: /(执行命令|运行命令|帮我执行|请执行|帮我拉取一下\s*git|帮我\s*pull|git pull|git status|git fetch|git branch|git log)/i, reason: '本地可执行的简单命令请求', taskKind: 'repo_query' },
  { pattern: /(读取文件|查看文件|打开文件|搜索文本|查找字符串)/i, reason: '本地文件读取或检索请求', taskKind: 'tool_request' },
  { pattern: /(帮我总结|概括一下|提炼一下|简要说明)/i, reason: '总结类请求', taskKind: 'summarize' },
];

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxChars: number): string {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function summarizeHistoryEntry(role: 'user' | 'assistant', content: string): string {
  const label = role === 'assistant' ? 'Assistant' : 'User';
  return `${label}: ${truncateText(content, MAX_HISTORY_ENTRY_CHARS)}`;
}

export function getLocalRouterMode(config: Config): LocalRouterMode {
  const raw = (config.localLlmRouterMode || '').trim().toLowerCase();
  if (raw === 'hybrid' || raw === 'local_only' || raw === 'codex_only') return raw;
  return config.localLlmFallbackToCodex === false ? 'local_only' : 'hybrid';
}

export function getRouterMaxInputChars(config: Config): number {
  const raw = config.localLlmRouterMaxInputChars ?? config.localLlmMaxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  return Math.max(1200, Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_MAX_INPUT_CHARS);
}

export function getRouterMaxHistoryItems(config: Config): number {
  const raw = config.localLlmRouterMaxHistoryItems ?? DEFAULT_ROUTER_HISTORY_ITEMS;
  return Math.max(2, Math.min(12, Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_ROUTER_HISTORY_ITEMS));
}

export function compressConversationHistory(params: StreamChatParams, config: Config): string {
  const items = (params.conversationHistory || []).slice(-getRouterMaxHistoryItems(config));
  const lines = items
    .map((item) => summarizeHistoryEntry(item.role, item.content))
    .filter(Boolean);
  return truncateText(lines.join('\n'), DEFAULT_ROUTER_HISTORY_CHARS);
}

export function compressPromptText(params: StreamChatParams, config: Config): string {
  return truncateText(params.prompt || '', Math.min(DEFAULT_ROUTER_PROMPT_CHARS, getRouterMaxInputChars(config)));
}

export function createCompressedParams(
  params: StreamChatParams,
  compressedPrompt: string,
  compressedHistory: string,
  routeReason: string,
): StreamChatParams {
  const history = compressedHistory
    ? [{ role: 'assistant' as const, content: `Compressed context:\n${compressedHistory}` }]
    : [];
  const systemPrompt = [params.systemPrompt?.trim(), `Local router summary: ${routeReason}`]
    .filter(Boolean)
    .join('\n\n');
  return {
    ...params,
    prompt: compressedPrompt || params.prompt,
    conversationHistory: history,
    systemPrompt,
  };
}

function buildCombinedInput(params: StreamChatParams, config: Config): string {
  return [compressPromptText(params, config), compressConversationHistory(params, config)]
    .filter(Boolean)
    .join('\n');
}

function totalHistoryChars(params: StreamChatParams): number {
  return (params.conversationHistory || []).reduce((sum, item) => sum + item.content.length, 0);
}

function looksLikeExecutionIntent(text: string): boolean {
  return /(执行|运行|帮我拉取|帮我\s*pull|帮我查一下|帮我看看|直接做|直接处理|请处理)/i.test(text);
}

export function decideConservativeRoute(params: StreamChatParams, config: Config): ConservativeRouteDecision {
  const compressedPrompt = compressPromptText(params, config);
  const compressedHistory = compressConversationHistory(params, config);

  const fallback = (patch: Partial<ConservativeRouteDecision>): ConservativeRouteDecision => ({
    useLocal: false,
    requestKind: 'chat',
    reason: '未命中本地规则',
    highRisk: false,
    readOnlyDraftOnly: false,
    preferredDecision: 'escalate_codex',
    compressedPrompt,
    compressedHistory,
    executionIntent: false,
    canFastPath: false,
    ...patch,
  });

  if (config.localLlmEnabled !== true) {
    return fallback({ requestKind: 'chat', reason: '本地模型未启用' });
  }

  if (params.files && params.files.length > 0) {
    return fallback({
      requestKind: 'tool_request',
      reason: '包含文件或附件',
      highRisk: true,
      preferredDecision: 'refuse_local',
    });
  }

  const combinedInput = buildCombinedInput(params, config);
  const maxInputChars = getRouterMaxInputChars(config);
  if (combinedInput.length > maxInputChars || totalHistoryChars(params) > Math.min(maxInputChars, 3600)) {
    return fallback({
      requestKind: 'chat',
      reason: '上下文过长，不适合本地直接处理',
    });
  }

  for (const rule of HARD_EXCLUDE_PATTERNS) {
    if (rule.pattern.test(combinedInput)) {
      return fallback({
        requestKind: rule.taskKind || 'tool_request',
        reason: rule.reason,
        highRisk: true,
        preferredDecision: 'escalate_codex',
      });
    }
  }

  for (const rule of LOCAL_FRIENDLY_PATTERNS) {
    if (rule.pattern.test(combinedInput)) {
      const executionIntent = rule.taskKind === 'repo_query' || rule.taskKind === 'tool_request'
        ? looksLikeExecutionIntent(combinedInput) || /\bgit (pull|status|fetch|branch|log)\b/i.test(combinedInput)
        : false;
      return fallback({
        useLocal: true,
        requestKind: rule.taskKind || 'chat',
        reason: rule.reason,
        preferredDecision: 'answer_local',
        readOnlyDraftOnly: rule.taskKind === 'command_draft',
        executionIntent,
        canFastPath: executionIntent,
      });
    }
  }

  return fallback({
    requestKind: 'chat',
    reason: '未命中保守本地规则',
  });
}

export function buildLocalRoutePrompt(params: StreamChatParams, config: Config): string {
  const compressedPrompt = compressPromptText(params, config);
  const compressedHistory = compressConversationHistory(params, config);
  const mode = getLocalRouterMode(config);
  return [
    '你是本地模型路由中枢。你不直接给用户最终答案，你只负责判断是否本地回答、是否需要升级到更强模型，以及压缩上下文。',
    '只允许输出一个严格 JSON 对象，不要输出 Markdown，不要解释，不要多余文本。',
    '允许的 decision: answer_local | escalate_codex | refuse_local',
    '允许的 taskKind: chat | explain | summarize | config_help | command_draft | script_draft | code_explain | tool_request | repo_query | unity_like | blender_like | doc_like',
    '如果请求涉及真实执行、真实查询仓库状态、改代码、写文件、运行 Unity、操作 Blender、MCP 工具、飞书文档创建/删除、发布、图片附件理解，应优先 decision=escalate_codex 或 refuse_local。',
    '如果是简单解释、配置说明、日志总结、命令草案、小脚本草案、代码片段解释，可以 decision=answer_local。',
    '如果用户只是让你解释一条错误文本，即使里面出现 git 或 FETCH_HEAD，只要不是要求真实查仓库状态，也可以 answer_local。',
    `当前运行模式: ${mode}`,
    '',
    '输出 JSON 字段必须包含：',
    'decision, taskKind, reason, needsCodex, canAnswerLocally, compressedPrompt, compressedHistory, suggestedReplyMode, safetyFlags',
    '',
    `当前用户请求:\n${compressedPrompt || '(empty)'}`,
    '',
    `最近相关历史:\n${compressedHistory || '(none)'}`,
  ].join('\n');
}

function extractJsonObject(raw: string): string {
  const text = raw.trim();
  const start = text.indexOf('{');
  if (start === -1) throw new Error('路由结果缺少 JSON 对象');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  throw new Error('路由结果 JSON 不完整');
}

function toTaskKind(value: string | undefined, fallback: LocalTaskKind = 'chat'): LocalTaskKind {
  const valid: LocalTaskKind[] = ['chat', 'explain', 'summarize', 'config_help', 'command_draft', 'script_draft', 'code_explain', 'tool_request', 'repo_query', 'unity_like', 'blender_like', 'doc_like'];
  return valid.includes(value as LocalTaskKind) ? (value as LocalTaskKind) : fallback;
}

function toDecision(value: string | undefined): LocalRouterDecisionType {
  if (value === 'answer_local' || value === 'escalate_codex' || value === 'refuse_local') return value;
  throw new Error('路由 decision 非法');
}

export function parseLocalRoutePayload(rawText: string, params: StreamChatParams, config: Config): LocalRouteProtocolResult {
  const jsonText = extractJsonObject(rawText);
  const parsed = JSON.parse(jsonText) as Partial<LocalRouteProtocolResult>;
  const compressedPrompt = truncateText(String(parsed.compressedPrompt || '').trim(), getRouterMaxInputChars(config));
  if (!compressedPrompt) throw new Error('路由结果缺少 compressedPrompt');
  const compressedHistory = truncateText(String(parsed.compressedHistory || '').trim(), DEFAULT_ROUTER_HISTORY_CHARS);
  return {
    decision: toDecision(parsed.decision),
    taskKind: toTaskKind(parsed.taskKind, 'chat'),
    reason: truncateText(String(parsed.reason || '本地模型未提供原因'), 180),
    needsCodex: Boolean(parsed.needsCodex),
    canAnswerLocally: parsed.canAnswerLocally !== false,
    compressedPrompt,
    compressedHistory,
    suggestedReplyMode: truncateText(String(parsed.suggestedReplyMode || 'concise'), 48),
    safetyFlags: Array.isArray(parsed.safetyFlags) ? parsed.safetyFlags.map((item) => String(item)) : [],
  };
}

export function createLocalOnlyLimitMessage(reason: string, taskKind: string, commandDraftOnly = false): string {
  if (commandDraftOnly) {
    return `当前是仅本地模式。这类请求我可以给你命令草案，但不会直接执行或声称拿到了真实结果。原因：${reason}`;
  }
  if (taskKind === 'repo_query') {
    return `当前是仅本地模式。我可以直接执行简单 Git 命令，或给你 Git 命令和排查思路；如果当前请求超出本地执行范围，我不会伪造仓库结果。原因：${reason}`;
  }
  if (taskKind === 'unity_like' || taskKind === 'blender_like' || taskKind === 'tool_request') {
    return `当前是仅本地模式。我不能伪装完成这类工具链操作，只能给你建议步骤。原因：${reason}`;
  }
  return `当前是仅本地模式。这类请求超出本地模型可安全完成的范围。我可以继续给你解释、建议或草案，但不会伪造执行结果。原因：${reason}`;
}
