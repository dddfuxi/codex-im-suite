import type { FileAttachment, MemoryQueryPlan } from './host.js';
import {
  describeInputEvidence,
  type InputEvidenceKind,
} from './input-evidence.js';

export type ExecutionRequirementKind = 'none' | 'input_evidence_required' | 'local_read_required' | 'tool_required' | 'artifact_required';

export interface ExecutionRequirement {
  kind: ExecutionRequirementKind;
  reason: string;
  requiredToolFamilies: string[];
  requiredInputEvidenceKinds?: InputEvidenceKind[];
  requiredInputEvidenceIds?: string[];
  strictToolEvidence?: boolean;
}

export interface ExecutionRequirementInput {
  userText: string;
  workingDirectory?: string;
  files?: FileAttachment[];
  memoryPlan?: MemoryQueryPlan;
  /** Bridge 已完成或安全收口本轮记忆意图；不得再按正文里的路径/Prefab 词触发工具任务。 */
  memoryIntentHandled?: boolean;
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
const TOOL_REQUIRED_RE = /(unity|unitymcp|unity mcp|mcp|blender|prefab|game\s*view|scene\s*view|powershell|pwsh|cmd\s*\/c|node\s+-|python|py\s+-|npm|npx|dotnet|git\s+|截图|截个图|截一张|场景|节点|运行|执行|命令|启动|停止|重启|安装|导入|导出|生成|创建|新建|写入|保存|删除|移动|复制|修改|替换|提交|发布|编辑|标注|圈出|圈起来|裁剪|压缩|转换|合成|修图|抠图|遮挡|打码)/iu;
const ARTIFACT_RE = /(生成|创建|导出|保存|截图|截个图|截一张|文件|文档|上传|下载|game\s*view|scene\s*view|编辑|标注|圈出|圈起来|裁剪|压缩|转换|合成|修图|抠图|遮挡|打码)/iu;
const ACTION_VERB_RE = /(截图|截个图|截一张|运行|执行|命令|启动|停止|重启|安装|导入|导出|生成|创建|新建|写入|保存|删除|移动|复制|修改|替换|提交|发布)/iu;
const INPUT_ARTIFACT_ACTION_RE = /(生成|创建|导出|保存|截个图|截一张|上传|下载|编辑|标注|圈出|圈起来|裁剪|压缩|转换|合成|修图|抠图|遮挡|打码|写入|修改|替换)/iu;
const READ_ONLY_IMAGE_ANALYSIS_RE = /(分析|总结|识别|查看|看看|看一下|看一眼|解释|读取|提取|判断|检查|诊断).{0,24}(?:图片|图像|照片|截图|画面|附件)|(?:图片|图像|照片|截图|画面|附件).{0,24}(?:分析|总结|识别|查看|看看|解释|读取|提取|判断|检查|诊断)/iu;
const EXTERNAL_MUTATION_ACTION_RE = /(?:(?:修复|修一下|修改|改一下|调整(?:一下)?|处理(?:一下)?|重建|创建|删除|运行|执行|启动|停止|重启|导入|导出).{0,32}(?:unity(?:\s*mcp)?|blender|mcp|game\s*view|scene\s*view|当前场景|场景(?:里的|中的)?(?:对象|节点|组件|物体|层级))|(?:unity(?:\s*mcp)?|blender|mcp|game\s*view|scene\s*view|当前场景|场景(?:里的|中的)?(?:对象|节点|组件|物体|层级)).{0,32}(?:修复|修一下|修改|改一下|调整(?:一下)?|处理(?:一下)?|重建|创建|删除|运行|执行|启动|停止|重启|导入|导出))/iu;
const EXTERNAL_READ_STATE_RE = /(?:(?:分析|诊断|检查|查看|看看|看一下|看一眼|看一看|查询|列出|列一下|读取|获取|扫描|查找|搜索).{0,32}(?:mcp|game\s*view|scene\s*view|当前场景|场景(?:里的|中的)?(?:对象|节点|组件|物体|层级))|(?:mcp|game\s*view|scene\s*view|当前场景|场景(?:里的|中的)?(?:对象|节点|组件|物体|层级)).{0,32}(?:分析|诊断|检查|查看|看看|看一下|看一眼|看一看|查询|列出|列一下|读取|获取|扫描|查找|搜索))/iu;
const EXPLICIT_EXTERNAL_READ_INVOCATION_RE = /(?:用|使用|通过|调用|连接到?)\s*(?:unity(?:\s*mcp)?|blender|mcp).{0,32}(?:分析|诊断|检查|查看|看看|看一下|看一眼|看一看|查询|列出|列一下|读取|获取|扫描|查找|搜索)|(?:分析|诊断|检查|查看|看看|看一下|看一眼|看一看|查询|列出|列一下|读取|获取|扫描|查找|搜索).{0,32}(?:用|使用|通过|调用|连接到?)\s*(?:unity(?:\s*mcp)?|blender|mcp)/iu;
const ACTION_SIGNAL_GLOBAL_RE = /(?:使用|通过|调用|连接到?|修复|修一下|修改|改一下|调整(?:一下)?|处理(?:一下)?|重建|创建|删除|运行|执行|启动|停止|重启|导入|导出|生成|保存|编辑|标注|圈出|裁剪|转换|分析|诊断|检查|查看|看看|看一下|看一眼|看一看|查询|列出|列一下|读取|获取|扫描|查找|搜索|用)/giu;
const LOCAL_NEGATION_MODAL_RE = /(?:不要|不必|不能|不需要|不想|不打算|不准备|不希望|不考虑|不是|无法|没法|没有必要|不可|不允许|别|无需|无须|禁止|勿)/u;
const DIRECT_NEGATION_PREFIX_RE = /不(?:\s|再|继续|直接|实际|真的|立即|现在|重新|尝试)*$/u;
const DOUBLE_NEGATION_SCOPE_RE = /(?:不得不|不能不|不是不|不可能不)/u;
const NEGATED_TARGET_ATTRIBUTE_RE = /(?:不需要|不可见|不是|没有必要|未(?:使用|激活|启用|加载|选择|保存|处理|修改|删除|检查|查看|完成|采用|配置|绑定)).{0,24}?的/giu;
const EXTERNAL_TARGET_LABEL_RE = /(?:unity(?:\s*mcp)?|blender|mcp|game\s*view|scene\s*view|当前场景|场景(?:里的|中的)?(?:对象|节点|组件|物体|层级)?)/iu;
const ACTION_SCOPE_RESET_RE = /(?:[，,。；;！？!?\n]+|但(?:是)?|不过|然而|而是|而要|却(?:要)?|同时|并且|以及|转而|只是|然后|随后|接着|继而|改由|改为)/u;
const SCREENSHOT_SUFFIX_EXTERNAL_LABEL_RE = /(?:unity(?:\s*mcp)?|blender|mcp|game\s*view|scene\s*view|当前场景|场景(?:里的|中的)?(?:对象|节点|组件|物体|层级)?)(?:\s*的)?\s*截图/giu;
const SCREENSHOT_PREFIX_EXTERNAL_LABEL_RE = /截图(?:里|里的|中|中的|所示的)\s*(?:unity(?:\s*mcp)?|blender|mcp|game\s*view|scene\s*view|当前场景|场景(?:里的|中的)?(?:对象|节点|组件|物体|层级)?)/giu;
const NEGATIVE_EXECUTION_RESULT_RE = /(未完成|失败|无法|不能|没有|未能|不可用|阻塞|报错|错误|找不到|不存在|未执行|已拒绝|exitCode|exited with code)/i;
const EXPLICIT_INCOMPLETE_REPLY_RE = /(未完成|没有拿到|没拿到|未能|无法|不能|不可用|阻塞|失败|报错|错误|找不到|不存在|未执行|已拒绝)/i;
const INSPECTION_ACTION_RE = /(看一下|看一眼|看看|查看|查询|列出|列一下|查找|搜索|找|总结|统计|读取|获取|扫描|盘点|有[^，。；\n]*组件|组件|物体|对象|节点|层级|hierarchy)/iu;
const TOOL_DOMAIN_RE = /(unity|unitymcp|unity mcp|mcp|blender|prefab|game\s*view|scene\s*view|GameObject|Assets|Packages|ProjectSettings|场景|节点|组件|物体|对象|层级|Hierarchy)/iu;
const STRICT_EVIDENCE_FAMILIES = new Set(['artifact', 'filesystem', 'shell', 'unity-mcp', 'blender']);
const PATH_LIKE_TARGET_RE = /(?:[A-Za-z]:[\\/]|(?:^|[\s"'`])\.{1,2}[\\/]|[\w.-]+[\\/][\w .\\/.-]+|\.(?:md|json|txt|ts|tsx|js|mjs|cjs|cs|prefab|unity|yml|yaml|toml|env|log)\b)/iu;
const LOW_RISK_CONTEXT_TARGET_RE = /(工作目录|当前目录|本地目录|项目结构|仓库结构|目录|文件夹|子目录|路径|文件|仓库|workspace|repo|repository|mcp\s*manifest|manifest|config\/mcp\.d|配置目录)/iu;
const COMMAND_INVOCATION_RE = /(powershell|pwsh|cmd\s*\/c|node\s+-|python|py\s+-|npm|npx|dotnet|git\s+)/iu;
const DEFERRED_REMINDER_INTENT_RE = /(?:(?:\d+\s*)?(?:分钟|小时|天|周|星期|礼拜)后|明天|后天|今天|今晚|上午|下午|晚上|\d{1,2}\s*[点:：]).{0,30}(?:提醒|提示|叫我|告诉我|发消息)|(?:提醒|提示|叫我|告诉我|发消息).{0,30}(?:(?:\d+\s*)?(?:分钟|小时|天|周|星期|礼拜)后|明天|后天|今天|今晚|上午|下午|晚上|\d{1,2}\s*[点:：])/iu;

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
  if (kind === 'input_evidence_required' || kind === 'artifact_required' || kind === 'local_read_required') return true;
  return families.some((family) => STRICT_EVIDENCE_FAMILIES.has(family));
}

function makeExecutionRequirement(
  kind: ExecutionRequirementKind,
  reason: string,
  requiredToolFamilies: string[],
  inputEvidence?: { kinds: InputEvidenceKind[]; ids: string[] },
): ExecutionRequirement {
  return {
    kind,
    reason,
    requiredToolFamilies,
    ...(inputEvidence ? {
      requiredInputEvidenceKinds: inputEvidence.kinds,
      requiredInputEvidenceIds: inputEvidence.ids,
    } : {}),
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

function shouldRequireToolEvidenceByDefault(
  text: string,
  kind: ExecutionRequirementKind,
  families: string[],
): boolean {
  const familySet = new Set(families.map((family) => family.trim().toLowerCase()).filter(Boolean));
  if (familySet.has('unity-mcp') || familySet.has('mcp') || familySet.has('web-search')) return true;
  if (kind === 'artifact_required' && /(截图|截个图|截一张|截屏|图片|图像|game\s*(?:view|视角)|scene\s*view|screenshot|capture)/iu.test(text)) {
    return true;
  }
  return false;
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

function normalizeAffirmativeActionText(text: string): string {
  const screenshotNormalized = text
    .replace(SCREENSHOT_SUFFIX_EXTERNAL_LABEL_RE, '截图')
    .replace(SCREENSHOT_PREFIX_EXTERNAL_LABEL_RE, '截图');
  const actionSource = screenshotNormalized
    .split(ACTION_SCOPE_RESET_RE)
    .map((segment) => segment.replace(NEGATED_TARGET_ATTRIBUTE_RE, (attribute) => (
      attribute.match(EXTERNAL_TARGET_LABEL_RE)?.[0] || ''
    )))
    .join('\n');

  // 逐动作维护局部极性：否定可覆盖紧随动作，转向后重置，双重否定恢复为肯定。
  let normalized = '';
  let cursor = 0;
  let previousActionEnd = 0;
  let inheritedNegation: boolean = false;

  for (const match of actionSource.matchAll(ACTION_SIGNAL_GLOBAL_RE)) {
    const action = match[0];
    const offset = match.index ?? 0;
    const betweenActions = actionSource.slice(previousActionEnd, offset);
    if (ACTION_SCOPE_RESET_RE.test(betweenActions)) inheritedNegation = false;

    const localScope = (betweenActions.split(ACTION_SCOPE_RESET_RE).at(-1) || '')
      .replace(NEGATED_TARGET_ATTRIBUTE_RE, '');
    const doubleNegation = DOUBLE_NEGATION_SCOPE_RE.test(localScope);
    const localNegation = !doubleNegation
      && (LOCAL_NEGATION_MODAL_RE.test(localScope) || DIRECT_NEGATION_PREFIX_RE.test(localScope));
    const actionNegated: boolean = doubleNegation ? false : localNegation || inheritedNegation;

    normalized += actionSource.slice(cursor, offset);
    if (!actionNegated) normalized += action;
    cursor = offset + action.length;
    previousActionEnd = cursor;
    inheritedNegation = actionNegated;
  }

  normalized += actionSource.slice(cursor);
  return normalized.replace(new RegExp(ACTION_SCOPE_RESET_RE.source, 'gu'), '\n');
}

function hasExplicitExternalToolAction(actionText: string): boolean {
  // 只对肯定动作判断：截图标签和否定子句已在统一归一化入口剥离。
  return EXTERNAL_MUTATION_ACTION_RE.test(actionText)
    || EXTERNAL_READ_STATE_RE.test(actionText)
    || EXPLICIT_EXTERNAL_READ_INVOCATION_RE.test(actionText);
}

function classifyExecutionRequirementInternal(
  input: ExecutionRequirementInput,
  options: { respectStrictToolRouting: boolean },
): ExecutionRequirement {
  const text = (input.userText || '').trim();

  if (isFeishuStickerMessageKind(input.messageKind) || isGeneratedFeishuStickerSemanticEvent(text)) {
    return NONE_REQUIREMENT;
  }

  const inputEvidence = describeInputEvidence(input.files);
  const imageEvidence = inputEvidence.filter((item) => item.kind === 'image');
  const affirmativeActionText = normalizeAffirmativeActionText(text);
  if (!text && imageEvidence.length === 0) return NONE_REQUIREMENT;

  if (imageEvidence.length > 0 && INPUT_ARTIFACT_ACTION_RE.test(affirmativeActionText)) {
    return makeExecutionRequirement(
      'artifact_required',
      'request asks to create or modify an output artifact from structured input evidence',
      inferToolFamilies(text, input.files),
    );
  }

  if (
    imageEvidence.length > 0
    && READ_ONLY_IMAGE_ANALYSIS_RE.test(text)
    && !hasExplicitExternalToolAction(affirmativeActionText)
  ) {
    return makeExecutionRequirement(
      'input_evidence_required',
      'request depends on provider-accepted structured input evidence',
      [],
      {
        kinds: ['image'],
        ids: imageEvidence.map((item) => item.id),
      },
    );
  }

  const asksForExternalExecution = TOOL_REQUIRED_RE.test(text) || (TOOL_DOMAIN_RE.test(text) && INSPECTION_ACTION_RE.test(text));
  if (imageEvidence.length > 0 && !asksForExternalExecution) {
    return makeExecutionRequirement(
      'input_evidence_required',
      'request depends on provider-accepted structured input evidence',
      [],
      {
        kinds: ['image'],
        ids: imageEvidence.map((item) => item.id),
      },
    );
  }

  if (input.memoryIntentHandled) {
    return NONE_REQUIREMENT;
  }

  if (input.memoryPlan?.intent === 'explicit_recall') {
    return NONE_REQUIREMENT;
  }

  if (MEMORY_RECALL_RE.test(text) && !LOCAL_TARGET_RE.test(text) && !TOOL_REQUIRED_RE.test(text)) {
    return NONE_REQUIREMENT;
  }

  if (DEFERRED_REMINDER_INTENT_RE.test(text)) {
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
    const families = inferToolFamilies(text, input.files);
    if (
      options.respectStrictToolRouting
      && !strictToolRoutingEnabled()
      && !shouldRequireToolEvidenceByDefault(text, kind, families)
    ) {
      return NONE_REQUIREMENT;
    }
    const requirement = makeExecutionRequirement(
      kind,
      'request asks for a concrete tool, MCP, file, command, or artifact action',
      families,
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
  if (/unity|unitymcp|unity mcp|prefab|预制体|场景|节点|game\s*(?:view|视角)|scene\s*view/iu.test(text)) families.add('unity-mcp');
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
  if (requirement.kind === 'input_evidence_required') {
    const kinds = requirement.requiredInputEvidenceKinds?.join(', ') || 'input';
    const ids = requirement.requiredInputEvidenceIds?.join(', ') || 'unknown';
    return [
      'Structured input evidence requirement for this turn:',
      `- Requirement: ${requirement.kind}.`,
      `- Reason: ${requirement.reason}.`,
      `- Required input evidence kinds: ${kinds}.`,
      `- Required input evidence IDs: ${ids}.`,
      '- Base the answer on the attached evidence actually supplied to this provider.',
      '- If the input evidence is unavailable or unreadable, reply with "未完成：" and the concrete input blocker instead of guessing from filenames or history.',
    ].join('\n');
  }
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
  if (requirement.kind === 'input_evidence_required') {
    return [
      'The previous attempt did not confirm provider acceptance of the required structured input evidence.',
      `Required input evidence IDs: ${(requirement.requiredInputEvidenceIds || []).join(', ') || 'unknown'}.`,
      'Retry with a provider that supports the required input evidence. Do not infer content from filenames, metadata, memory, or nearby messages.',
      'If the input cannot be accepted, reply only with "未完成：" and the concrete input blocker.',
    ].join('\n');
  }
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

function normalizeToolEvidenceName(name: string): string {
  return name.trim().toLowerCase();
}

function hasUnityMcpToolEvidence(toolNames: string[]): boolean {
  return toolNames.some((name) => {
    const normalized = normalizeToolEvidenceName(name);
    return normalized.includes('jsontool:mcp_call')
      || normalized.includes('jsontool:unity_mcp_execute_code')
      || normalized.includes('unity')
      || normalized.includes('mcp')
      || /(^|[:/._-])(manage_camera|manage_scene|manage_asset|manage_gameobject|find_gameobjects|execute_code|batch_execute)(?:$|[:/._-])/.test(normalized);
  });
}

function hasMcpToolEvidence(toolNames: string[]): boolean {
  return toolNames.some((name) => {
    const normalized = normalizeToolEvidenceName(name);
    return normalized.includes('jsontool:mcp_call')
      || normalized.includes('mcp')
      || /(^|[:/._-])(web_search|search|fetch|query)(?:$|[:/._-])/.test(normalized);
  });
}

function hasRequiredToolFamilyEvidence(
  requirement: ExecutionRequirement,
  evidence: { successfulToolResultCount: number; toolNames?: string[] },
): boolean {
  if (evidence.successfulToolResultCount <= 0) return false;
  const toolNames = evidence.toolNames || [];
  // 兼容老测试 / 老 provider：没有工具名时只能退回计数判断。
  // 运行时 consumeStream 会填 toolNames，因此实际 IM turn 会按 family 继续校验。
  if (toolNames.length === 0) return true;

  const families = new Set(requirement.requiredToolFamilies.map((family) => family.trim().toLowerCase()).filter(Boolean));
  if (families.has('unity-mcp')) return hasUnityMcpToolEvidence(toolNames);
  if (families.has('mcp') || families.has('web-search')) return hasMcpToolEvidence(toolNames);
  return true;
}

export function isExecutionEvidenceSatisfied(
  requirement: ExecutionRequirement,
  evidence: {
    successfulToolResultCount: number;
    toolNames?: string[];
    acceptedInputEvidenceIds?: string[];
    acceptedInputEvidenceKinds?: InputEvidenceKind[];
  },
): boolean {
  if (requirement.kind === 'input_evidence_required') {
    const acceptedIds = new Set(evidence.acceptedInputEvidenceIds || []);
    const acceptedKinds = new Set(evidence.acceptedInputEvidenceKinds || []);
    const requiredIds = requirement.requiredInputEvidenceIds || [];
    const requiredKinds = requirement.requiredInputEvidenceKinds || [];
    return requiredIds.length > 0
      && requiredIds.every((id) => acceptedIds.has(id))
      && requiredKinds.every((kind) => acceptedKinds.has(kind));
  }
  if (!requiresSuccessfulToolEvidence(requirement)) return true;
  return hasRequiredToolFamilyEvidence(requirement, evidence);
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
  evidence: {
    toolResultCount: number;
    successfulToolResultCount: number;
    acceptedInputEvidenceIds?: string[];
    acceptedInputEvidenceKinds?: InputEvidenceKind[];
  },
  responseText: string,
): boolean {
  if (!requiresSuccessfulToolEvidence(requirement)) return false;
  if (isExecutionEvidenceSatisfied(requirement, evidence)) return false;

  if (requirement.kind !== 'input_evidence_required' && ctiFinalDeclaresArtifacts(responseText)) {
    return false;
  }

  if (EXPLICIT_INCOMPLETE_REPLY_RE.test(responseText)) {
    return false;
  }

  if (evidence.toolResultCount > 0 && NEGATIVE_EXECUTION_RESULT_RE.test(responseText)) {
    return false;
  }

  return true;
}

export function buildNoExecutionEvidenceText(
  requirement: ExecutionRequirement,
  evidence: {
    toolUseCount: number;
    toolResultCount: number;
    successfulToolResultCount: number;
    toolNames: string[];
    failedToolErrors?: string[];
    acceptedInputEvidenceIds?: string[];
    acceptedInputEvidenceKinds?: InputEvidenceKind[];
    inputEvidenceProvider?: string;
  },
): string {
  if (requirement.kind === 'input_evidence_required') {
    return [
      '未完成：本轮模型执行没有确认接收到所需输入证据。',
      `证据要求：${requirement.kind}`,
      `需要的输入证据：${(requirement.requiredInputEvidenceIds || []).join('、') || '未记录'}`,
      `已接收输入证据：${(evidence.acceptedInputEvidenceIds || []).join('、') || '0'}`,
      `Provider：${evidence.inputEvidenceProvider || '未确认'}`,
    ].join('\n');
  }
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
