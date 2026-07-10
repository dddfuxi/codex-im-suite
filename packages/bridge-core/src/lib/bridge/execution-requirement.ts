import type { FileAttachment, MemoryQueryPlan } from './host.js';

export type ExecutionRequirementKind = 'none' | 'local_read_required' | 'tool_required' | 'artifact_required';

export interface ExecutionRequirement {
  kind: ExecutionRequirementKind;
  reason: string;
  requiredToolFamilies: string[];
  strictToolEvidence?: boolean;
}

export interface ExecutionRequirementInput {
  userText: string;
  workingDirectory?: string;
  files?: FileAttachment[];
  memoryPlan?: MemoryQueryPlan;
  messageKind?: string;
  hasPreResolvedEvidence?: boolean;
}

const NONE_REQUIREMENT: ExecutionRequirement = {
  kind: 'none',
  reason: 'no local execution evidence required',
  requiredToolFamilies: [],
};

function strictToolRoutingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.CTI_STRICT_TOOL_ROUTING || '');
}

const MEMORY_RECALL_RE = /(记得|记不记得|之前.*说过|回忆|历史里|聊天记录里|记录|偏好)/iu;
const EXPLANATION_RE = /^(解释|说明|介绍|讲一下|说一下|为什么|怎么理解|原理|区别|方案|计划|总结|分析一下)/iu;
const NAME_LOOKUP_RE = /(叫啥|叫什么|名字|名称|是哪一个|叫作|叫做)/iu;
const LOCAL_READ_RE = /(看一看|看一下|看一眼|看看|查看|查一下|查询|列出|列一下|有哪些|有什么|目录|文件夹|子目录|工作目录|当前目录|本地目录|项目结构|仓库结构|读一下|读取|打开.*文件|搜索|搜一下|查找|grep|rg\b|ls\b|dir\b|get-childitem)/iu;
const LOCAL_TARGET_RE = /(本地|工作目录|当前目录|目录|文件夹|文件|项目|仓库|路径|Game|Assets|Packages|ProjectSettings|\.md|\.json|\.txt|\.ts|\.tsx|\.cs|\.prefab|\.unity)/iu;
const TOOL_REQUIRED_RE = /(unity|unitymcp|unity mcp|mcp|blender|prefab|game\s*view|scene\s*view|powershell|pwsh|cmd\s*\/c|node\s+-|python|py\s+-|npm|npx|dotnet|git\s+|截图|截个图|截一张|图片|图像|场景|节点|运行|执行|命令|启动|停止|重启|安装|导入|导出|生成|创建|新建|写入|保存|删除|移动|复制|修改|替换|提交|发布)/iu;
const ARTIFACT_RE = /(生成|创建|导出|保存|截图|截个图|截一张|图片|图像|文件|文档|上传|下载|game\s*view|scene\s*view)/iu;
const ACTION_VERB_RE = /(截图|截个图|截一张|运行|执行|命令|启动|停止|重启|安装|导入|导出|生成|创建|新建|写入|保存|删除|移动|复制|修改|替换|提交|发布)/iu;
const NEGATIVE_EXECUTION_RESULT_RE = /(未完成|失败|无法|不能|没有|未能|不可用|阻塞|报错|错误|找不到|不存在|未执行|已拒绝|exitCode|exited with code)/i;
const INSPECTION_ACTION_RE = /(看一下|看一眼|看看|查看|查询|列出|列一下|查找|搜索|找|总结|统计|读取|获取|扫描|盘点|有[^，。；\n]*组件|组件|物体|对象|节点|层级|hierarchy)/iu;
const TOOL_DOMAIN_RE = /(unity|unitymcp|unity mcp|mcp|blender|prefab|game\s*view|scene\s*view|GameObject|Assets|Packages|ProjectSettings|场景|节点|组件|物体|对象|层级|Hierarchy)/iu;
const STRICT_EVIDENCE_FAMILIES = new Set(['artifact', 'filesystem', 'shell', 'unity-mcp', 'blender']);
const PATH_LIKE_TARGET_RE = /(?:[A-Za-z]:[\\/]|(?:^|[\s"'`])\.{1,2}[\\/]|[\w.-]+[\\/][\w .\\/.-]+|\.(?:md|json|txt|ts|tsx|js|mjs|cjs|cs|prefab|unity|yml|yaml|toml|env|log)\b)/iu;
const LOW_RISK_CONTEXT_TARGET_RE = /(工作目录|当前目录|本地目录|项目结构|仓库结构|目录|文件夹|子目录|路径|文件|仓库|workspace|repo|repository|mcp\s*manifest|manifest|config\/mcp\.d|配置目录)/iu;
const COMMAND_INVOCATION_RE = /(powershell|pwsh|cmd\s*\/c|node\s+-|python|py\s+-|npm|npx|dotnet|git\s+)/iu;

export interface ToolResultQuality {
  ok: boolean;
  errorSummary?: string;
}

function truncateEvidenceText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readBooleanFailure(record: Record<string, unknown>): string {
  for (const key of ['ok', 'success', 'successful', 'completed']) {
    const value = record[key];
    if (value === false) return `${key}=false`;
  }
  for (const key of ['failed', 'error']) {
    const value = record[key];
    if (value === true) return `${key}=true`;
  }
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  if (status && /^(error|failed|failure|blocked|unavailable|timeout|timed_out)$/i.test(status)) {
    return `status=${status}`;
  }
  return '';
}

function summarizeStructuredFailure(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const booleanFailure = readBooleanFailure(record);
  const directError = readStringField(record, ['error', 'stderr']);
  if (directError) return directError;
  const directMessage = readStringField(record, ['message', 'reason']);
  if (booleanFailure && directMessage) return directMessage;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? summarizeStructuredFailure(record.data)
    : '';
  if (data) return data;
  const result = record.result && typeof record.result === 'object' && !Array.isArray(record.result)
    ? summarizeStructuredFailure(record.result)
    : '';
  if (result) return result;
  return booleanFailure;
}

export function classifyToolResultQuality(content: unknown, isError?: boolean): ToolResultQuality {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (isError === true) {
    return { ok: false, errorSummary: truncateEvidenceText(raw || 'tool_result is_error=true', 220) };
  }
  if (!raw) return { ok: true };

  try {
    const parsed = JSON.parse(raw) as unknown;
    const structuredFailure = summarizeStructuredFailure(parsed);
    if (structuredFailure) {
      return { ok: false, errorSummary: truncateEvidenceText(structuredFailure, 220) };
    }
  } catch {
    // Plain-text tool output is handled below.
  }

  return { ok: true };
}

function shouldRequireStrictToolEvidence(kind: ExecutionRequirementKind, families: string[]): boolean {
  if (kind === 'none') return false;
  if (kind === 'artifact_required' || kind === 'local_read_required') return true;
  return families.some((family) => STRICT_EVIDENCE_FAMILIES.has(family));
}

function makeExecutionRequirement(
  kind: ExecutionRequirementKind,
  reason: string,
  requiredToolFamilies: string[],
): ExecutionRequirement {
  return {
    kind,
    reason,
    requiredToolFamilies,
    strictToolEvidence: shouldRequireStrictToolEvidence(kind, requiredToolFamilies),
  };
}

function hasConcreteReadableContextTarget(text: string, input: ExecutionRequirementInput): boolean {
  if (PATH_LIKE_TARGET_RE.test(text)) return true;
  if (LOW_RISK_CONTEXT_TARGET_RE.test(text) && !!input.workingDirectory) return true;
  return false;
}

function shouldUseLowRiskLocalProbe(text: string, input: ExecutionRequirementInput): boolean {
  if (input.hasPreResolvedEvidence) return false;
  if (!LOCAL_READ_RE.test(text)) return false;
  if (!hasConcreteReadableContextTarget(text, input)) return false;
  if (COMMAND_INVOCATION_RE.test(text)) return false;
  // Mutating verbs still go through the stricter tool/action branches below.
  return !ACTION_VERB_RE.test(text);
}

export function isFeishuStickerMessageKind(messageKind?: string): boolean {
  return messageKind === 'feishu_sticker_unknown'
    || messageKind === 'feishu_sticker_known'
    || messageKind === 'feishu_sticker_image';
}

function isGeneratedFeishuStickerSemanticEvent(text: string): boolean {
  return /file_key=/i.test(text)
    && /飞书表情包/u.test(text)
    && /(尚未标注语义|已记录语义)/u.test(text);
}

function classifyExecutionRequirementInternal(
  input: ExecutionRequirementInput,
  options: { respectStrictToolRouting: boolean },
): ExecutionRequirement {
  const text = (input.userText || '').trim();
  if (!text) return NONE_REQUIREMENT;

  if (isFeishuStickerMessageKind(input.messageKind) || isGeneratedFeishuStickerSemanticEvent(text)) {
    return NONE_REQUIREMENT;
  }

  if (input.memoryPlan?.intent === 'explicit_recall') {
    return NONE_REQUIREMENT;
  }

  if (MEMORY_RECALL_RE.test(text) && !LOCAL_TARGET_RE.test(text) && !TOOL_REQUIRED_RE.test(text)) {
    return NONE_REQUIREMENT;
  }

  if (shouldUseLowRiskLocalProbe(text, input)) {
    return makeExecutionRequirement(
      'local_read_required',
      'low-risk readable context target is available for proactive inspection',
      ['shell', 'read', 'search'],
    );
  }

  if (EXPLANATION_RE.test(text) && !LOCAL_READ_RE.test(text) && !TOOL_REQUIRED_RE.test(text)) {
    return NONE_REQUIREMENT;
  }

  const asksForCurrentToolState = TOOL_DOMAIN_RE.test(text) && INSPECTION_ACTION_RE.test(text);

  if (NAME_LOOKUP_RE.test(text) && !LOCAL_READ_RE.test(text) && !ACTION_VERB_RE.test(text) && !asksForCurrentToolState) {
    return NONE_REQUIREMENT;
  }

  if (TOOL_REQUIRED_RE.test(text) || asksForCurrentToolState) {
    const kind = ARTIFACT_RE.test(text) ? 'artifact_required' : 'tool_required';
    if (options.respectStrictToolRouting && !strictToolRoutingEnabled()) {
      return NONE_REQUIREMENT;
    }
    const requirement = makeExecutionRequirement(
      kind,
      'request asks for a concrete tool, MCP, file, command, or artifact action',
      inferToolFamilies(text, input.files),
    );
    return requirement;
  }

  if (LOCAL_READ_RE.test(text) && (LOCAL_TARGET_RE.test(text) || !!input.workingDirectory)) {
    if (input.hasPreResolvedEvidence) return NONE_REQUIREMENT;
    if (options.respectStrictToolRouting && !strictToolRoutingEnabled()) {
      return NONE_REQUIREMENT;
    }
    const requirement = makeExecutionRequirement(
      'local_read_required',
      'request asks for factual local filesystem or workspace information',
      ['shell', 'read', 'search'],
    );
    return requirement;
  }

  return NONE_REQUIREMENT;
}

export function classifyExecutionRequirement(input: ExecutionRequirementInput): ExecutionRequirement {
  return classifyExecutionRequirementInternal(input, { respectStrictToolRouting: true });
}

function inferToolFamilies(text: string, files?: FileAttachment[]): string[] {
  const families = new Set<string>();
  if (/unity|unitymcp|unity mcp|prefab|场景|节点|game\s*view|scene\s*view/iu.test(text)) families.add('unity-mcp');
  if (/mcp/iu.test(text)) families.add('mcp');
  if (/blender/iu.test(text)) families.add('blender');
  if (/截图|截个图|截一张|图片|图像/iu.test(text) || (files?.length || 0) > 0) families.add('artifact');
  if (/文件|文档|目录|文件夹|项目|仓库|路径|读取|查看|列出|搜索|写入|保存|删除|移动|复制|修改|替换/iu.test(text)) families.add('filesystem');
  if (/powershell|pwsh|cmd\s*\/c|node\s+-|python|py\s+-|npm|npx|dotnet|git\s+|运行|执行|命令|启动|停止|重启|安装|发布/iu.test(text)) families.add('shell');
  if (families.size === 0) families.add('tool');
  return Array.from(families);
}

export function buildExecutionRequirementPrompt(requirement: ExecutionRequirement): string {
  if (requirement.kind === 'none') return '';
  const families = requirement.requiredToolFamilies.length
    ? requirement.requiredToolFamilies.join(', ')
    : 'appropriate tool';
  if (requirement.strictToolEvidence === false) {
    return [
      'Execution evidence preference for this turn:',
      `- Requirement: ${requirement.kind}.`,
      `- Reason: ${requirement.reason}.`,
      `- Preferred tool families: ${families}.`,
      '- Prefer a real tool when it is available.',
      '- If the preferred tool path is unavailable, you may still answer using the best available model knowledge, but do not claim that a tool succeeded.',
      '- When possible, include source names, dates, and uncertainty instead of fabricating tool evidence.',
    ].join('\n');
  }
  return [
    'Execution evidence requirement for this turn:',
    `- Requirement: ${requirement.kind}.`,
    `- Reason: ${requirement.reason}.`,
    `- Required tool families: ${families}.`,
    '- You must call an appropriate real tool before answering with local facts or completion claims.',
    '- Do not answer from memory, guesses, examples, or prior screenshots when the request asks for current local state.',
    '- If the required tool path is unavailable, answer with "未完成：" followed by the concrete blocker and the attempted tool path.',
  ].join('\n');
}

export function buildNoEvidenceRetryPrompt(requirement: ExecutionRequirement): string {
  return [
    'No successful tool result was detected in the previous attempt.',
    `This request still requires execution evidence: ${requirement.kind}.`,
    'Retry now by calling the required real tool first. Do not provide a factual local answer without a successful tool result.',
    'If you cannot call the tool, reply only with "未完成：" and the concrete blocker.',
  ].join('\n');
}

export function requiresSuccessfulToolEvidence(requirement: ExecutionRequirement): boolean {
  return requirement.kind !== 'none' && requirement.strictToolEvidence !== false;
}

export function isExecutionEvidenceSatisfied(
  requirement: ExecutionRequirement,
  evidence: { successfulToolResultCount: number },
): boolean {
  if (!requiresSuccessfulToolEvidence(requirement)) return true;
  return evidence.successfulToolResultCount > 0;
}

function ctiFinalDeclaresArtifacts(responseText: string): boolean {
  const matches = responseText.matchAll(/(?:^|\n)\s*```cti-final\s*\n([\s\S]*?)\n\s*```/gi);
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const images = Array.isArray(record.images) ? record.images : [];
      const files = Array.isArray(record.files) ? record.files : [];
      if (images.some((item) => typeof item === 'string' && item.trim())) return true;
      if (files.some((item) => typeof item === 'string' && item.trim())) return true;
    } catch {
      // Malformed cti-final should not bypass missing-evidence replacement.
    }
  }
  return false;
}

export function shouldReplaceWithNoExecutionEvidenceText(
  requirement: ExecutionRequirement,
  evidence: { toolResultCount: number; successfulToolResultCount: number },
  responseText: string,
): boolean {
  if (!requiresSuccessfulToolEvidence(requirement)) return false;
  if (isExecutionEvidenceSatisfied(requirement, evidence)) return false;

  if (ctiFinalDeclaresArtifacts(responseText)) {
    return false;
  }

  if (evidence.toolResultCount > 0 && NEGATIVE_EXECUTION_RESULT_RE.test(responseText)) {
    return false;
  }

  return true;
}

export function buildNoExecutionEvidenceText(
  requirement: ExecutionRequirement,
  evidence: { toolUseCount: number; toolResultCount: number; successfulToolResultCount: number; toolNames: string[]; failedToolErrors?: string[] },
): string {
  const lines = [
    '未完成：本轮没有检测到真实工具执行成功记录。',
    `证据要求：${requirement.kind}`,
    `原因：${requirement.reason}`,
    `本轮工具证据：tool_use=${evidence.toolUseCount}，tool_result=${evidence.toolResultCount}，成功结果=${evidence.successfulToolResultCount}。`,
  ];
  if (evidence.toolNames.length > 0) lines.push(`工具：${evidence.toolNames.slice(0, 6).join('、')}`);
  if (evidence.failedToolErrors?.length) lines.push(`失败原因：${evidence.failedToolErrors.slice(0, 3).join('；')}`);
  return lines.join('\n');
}
