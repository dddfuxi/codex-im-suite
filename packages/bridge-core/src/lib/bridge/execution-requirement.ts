import type { FileAttachment, MemoryQueryPlan } from './host.js';

export type ExecutionRequirementKind = 'none' | 'local_read_required' | 'tool_required' | 'artifact_required';

export interface ExecutionRequirement {
  kind: ExecutionRequirementKind;
  reason: string;
  requiredToolFamilies: string[];
}

export interface ExecutionRequirementInput {
  userText: string;
  workingDirectory?: string;
  files?: FileAttachment[];
  memoryPlan?: MemoryQueryPlan;
  messageKind?: string;
}

const NONE_REQUIREMENT: ExecutionRequirement = {
  kind: 'none',
  reason: 'no local execution evidence required',
  requiredToolFamilies: [],
};

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

export function classifyExecutionRequirement(input: ExecutionRequirementInput): ExecutionRequirement {
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

  if (EXPLANATION_RE.test(text) && !LOCAL_READ_RE.test(text) && !TOOL_REQUIRED_RE.test(text)) {
    return NONE_REQUIREMENT;
  }

  const asksForCurrentToolState = TOOL_DOMAIN_RE.test(text) && INSPECTION_ACTION_RE.test(text);

  if (NAME_LOOKUP_RE.test(text) && !LOCAL_READ_RE.test(text) && !ACTION_VERB_RE.test(text) && !asksForCurrentToolState) {
    return NONE_REQUIREMENT;
  }

  if (TOOL_REQUIRED_RE.test(text) || asksForCurrentToolState) {
    return {
      kind: ARTIFACT_RE.test(text) ? 'artifact_required' : 'tool_required',
      reason: 'request asks for a concrete tool, MCP, file, command, or artifact action',
      requiredToolFamilies: inferToolFamilies(text, input.files),
    };
  }

  if (LOCAL_READ_RE.test(text) && (LOCAL_TARGET_RE.test(text) || !!input.workingDirectory)) {
    return {
      kind: 'local_read_required',
      reason: 'request asks for factual local filesystem or workspace information',
      requiredToolFamilies: ['shell', 'read', 'search'],
    };
  }

  return NONE_REQUIREMENT;
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
  return requirement.kind !== 'none';
}

export function isExecutionEvidenceSatisfied(
  requirement: ExecutionRequirement,
  evidence: { successfulToolResultCount: number },
): boolean {
  if (!requiresSuccessfulToolEvidence(requirement)) return true;
  return evidence.successfulToolResultCount > 0;
}

export function shouldReplaceWithNoExecutionEvidenceText(
  requirement: ExecutionRequirement,
  evidence: { toolResultCount: number; successfulToolResultCount: number },
  responseText: string,
): boolean {
  if (!requiresSuccessfulToolEvidence(requirement)) return false;
  if (isExecutionEvidenceSatisfied(requirement, evidence)) return false;

  if (/```cti-final\b/i.test(responseText)) {
    return false;
  }

  if (evidence.toolResultCount > 0 && NEGATIVE_EXECUTION_RESULT_RE.test(responseText)) {
    return false;
  }

  return true;
}

export function buildNoExecutionEvidenceText(
  requirement: ExecutionRequirement,
  evidence: { toolUseCount: number; toolResultCount: number; successfulToolResultCount: number; toolNames: string[] },
): string {
  const lines = [
    '未完成：本轮没有检测到真实工具执行成功记录。',
    `证据要求：${requirement.kind}`,
    `原因：${requirement.reason}`,
    `本轮工具证据：tool_use=${evidence.toolUseCount}，tool_result=${evidence.toolResultCount}，成功结果=${evidence.successfulToolResultCount}。`,
  ];
  if (evidence.toolNames.length > 0) lines.push(`工具：${evidence.toolNames.slice(0, 6).join('、')}`);
  return lines.join('\n');
}
