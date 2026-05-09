export type InteractionIntent = 'query' | 'action' | 'explain' | 'ambiguous';
export type ExecutionRisk = 'none' | 'read_only' | 'mutating';

export interface MatchedSignals {
  query: string[];
  action: string[];
  object: string[];
  context: string[];
  system: string[];
  explain: string[];
  readOnly: string[];
  mutating: string[];
}

export interface FastPathInteractionAssessment {
  interactionIntent: InteractionIntent;
  executionRisk: ExecutionRisk;
  matchedSignals: MatchedSignals;
}

export type IgnisFastIntent = 'status' | 'skills' | 'result' | 'wait' | 'history' | 'resume' | 'generate';
export type McpFastIntent = 'status' | 'list_tools' | 'start' | 'stop' | 'tool_call';

interface SignalRule {
  label: string;
  pattern: RegExp;
}

const EXPLAIN_RULES: SignalRule[] = [
  { label: '概念解释', pattern: /(什么是|是什么|介绍|说明|原理|区别|why|what is)/i },
];

const GENERIC_QUERY_RULES: SignalRule[] = [
  { label: '查看查询', pattern: /(看下|看看|看一眼|查看|查一下|检查一下|检查|查询|列出|列一下|整理|汇总)/i },
  { label: '状态结果', pattern: /(历史|状态|结果|进度|最近|列表|汇总|刷新|获取|等待|工具列表|有哪些工具|有哪些技能)/i },
  { label: '重发回传', pattern: /(再发|重发|补发|重新发|发我一下|发我一份|回传|给我看)/i },
];

const GENERIC_ACTION_RULES: SignalRule[] = [
  { label: '显式请求动作', pattern: /(帮我|请|直接|现在|立刻|马上|把|用).{0,8}(启动|停止|重启|执行|运行|拉起|删除|修改|写入|pull|fetch|resume|继续回答|回答|选择)/i },
  { label: '命令式动作', pattern: /^(启动|停止|重启|执行|运行|拉起|删除|修改|写入|pull|fetch)\b/i },
  { label: '显式工具调用', pattern: /(调用\s+.*?mcp\s*工具|tools\/call)/i },
  { label: 'git pull/fetch', pattern: /\bgit (pull|fetch)\b/i },
];

const IGNIS_SYSTEM_RULES: SignalRule[] = [
  { label: 'Ignis', pattern: /\bignis\b/i },
];

const IGNIS_OBJECT_RULES: SignalRule[] = [
  { label: '创意资产', pattern: /(图片|图像|原画|概念图|分镜|视频|模型|3d|素材|asset)/i },
  { label: 'Ignis结果标识', pattern: /(turn_id|turn_|session_id|canvas|file_id)/i },
  { label: 'Ignis技能', pattern: /(skills|技能列表)/i },
];

const IGNIS_CONTEXT_RULES: SignalRule[] = [
  { label: '上一轮引用', pattern: /(上次|上一个|上一轮|上一版|刚才|之前|前面|上回|最近)/i },
  { label: '引用当前附件', pattern: /(该|这张|这次|这版|继续上一版|延续上一轮)/i },
];

const IGNIS_QUERY_RULES: SignalRule[] = [
  { label: 'Ignis历史', pattern: /(历史|history|最近几次|最近几轮|最近记录|最近列表|最近任务|最近会话|整理成列表|整理列表|列出来|列个表|列表发我|汇总成列表|汇总列表)/i },
  { label: 'Ignis状态', pattern: /(安装|装好|配置|配好|接入|部署|可用|能用|状态|在线|离线|连通|连接|健康|ready)/i },
  { label: 'Ignis结果', pattern: /(结果|进度|等待|等.*完成|好了没|好了吗|查结果|查进度|发我一下|回传)/i },
  { label: 'Ignis技能查询', pattern: /(skills|技能列表|有哪些技能|列出.*技能)/i },
];

const IGNIS_ACTION_RULES: SignalRule[] = [
  { label: 'Ignis生成', pattern: /(用|帮我|请|直接|现在|立刻|马上)\s*(?:ignis)?\s*(生成|画|绘制|做|制作|创建|出图|出一张|文生图|图生图|图生视频|文生视频|复刻)/i },
  { label: 'Ignis直述生成', pattern: /^\s*(?:ignis)\s*(生成|画|绘制|做|制作|创建|出图|出一张|文生图|图生图|图生视频|文生视频|复刻)\b(?!的)/i },
  { label: 'Ignis编辑', pattern: /(继续上一版|延续上一轮|改一下|换成|调整|再来)/i },
  { label: 'Ignis恢复', pattern: /(resume|继续回答|选择第|选第|回答)/i },
];

const IGNIS_READ_ONLY_RULES: SignalRule[] = [
  { label: 'Ignis只读查询', pattern: /(历史|状态|结果|进度|等待|技能|安装|配置|可用|在线|离线|健康)/i },
];

const IGNIS_MUTATING_RULES: SignalRule[] = [
  { label: 'Ignis生成任务', pattern: /(生成|画|绘制|做|制作|创建|出图|文生图|图生图|图生视频|文生视频|复刻|改一下|换成|调整|再来)/i },
  { label: 'Ignis恢复任务', pattern: /(resume|继续回答|选择第|选第|回答)/i },
];

const MCP_SYSTEM_RULES: SignalRule[] = [
  { label: 'MCP', pattern: /(mcp|unity\s*mcp|blender\s*mcp|picture\s*mcp|prefab\s*mcp|ignis\s*mcp|unitymcp|blendermcp|picturemcp|prefabmcp|ignismcp|图片\s*mcp|预制体\s*mcp)/i },
];

const MCP_OBJECT_RULES: SignalRule[] = [
  { label: 'MCP工具', pattern: /(工具|tools\/list|tools\/call|tool call)/i },
  { label: 'MCP状态', pattern: /(状态|连接|在线|离线|健康|可用|能用)/i },
];

const MCP_QUERY_RULES: SignalRule[] = [
  { label: 'MCP状态查询', pattern: /(检查|状态|连接|在线|离线|健康|可用|能用|看看|看下|帮助)/i },
  { label: 'MCP工具查询', pattern: /(工具列表|列出.*工具|有哪些工具|tools\/list)/i },
];

const MCP_ACTION_RULES: SignalRule[] = [
  { label: 'MCP启动', pattern: /(启动|拉起|连接|重启)/i },
  { label: 'MCP停止', pattern: /(停止|关闭)/i },
  { label: 'MCP工具调用', pattern: /(调用\s+.*?mcp\s*工具|tool call|tools\/call)/i },
];

const MCP_READ_ONLY_RULES: SignalRule[] = [
  { label: 'MCP只读', pattern: /(状态|连接|在线|离线|健康|可用|能用|工具列表|列出.*工具|有哪些工具|tools\/list)/i },
];

const MCP_MUTATING_RULES: SignalRule[] = [
  { label: 'MCP运维动作', pattern: /(启动|拉起|停止|关闭|重启)/i },
  { label: 'MCP显式调用', pattern: /(调用\s+.*?mcp\s*工具|tool call|tools\/call)/i },
];

const MCP_DOMAIN_WORK_RULES: SignalRule[] = [
  { label: 'Unity实际工作', pattern: /(unity里|场景|scene|hsscene|节点|gameobject|hierarchy|层级|prefab|预制体|材质|贴图|截图|相机|运行游戏|play\s*mode|导入|导出|分析.*节点|家具节点)/i },
  { label: 'Blender实际工作', pattern: /(blender里|模型|mesh|材质|贴图|渲染|导出|导入|glb|gltf|fbx)/i },
];

const EXECUTOR_OBJECT_RULES: SignalRule[] = [
  { label: 'Git', pattern: /\bgit\b/i },
  { label: '文件', pattern: /(文件|文本|字符串)/i },
];

const EXECUTOR_QUERY_RULES: SignalRule[] = [
  { label: '执行器查询', pattern: /(看下|看看|查看|查一下|检查|确认|读取|打开|搜索|查找|状态|分支|日志|历史|要不要|能不能)/i },
];

const EXECUTOR_ACTION_RULES: SignalRule[] = [
  { label: '执行器显式动作', pattern: /(帮我|请|直接|现在|立刻|马上|把).{0,8}(pull|fetch|写|修改|编辑|创建|删除|执行|运行)/i },
  { label: 'git pull/fetch', pattern: /\bgit (pull|fetch)\b/i },
  { label: '命令执行', pattern: /(?:执行|运行)命令/i },
  { label: '文件写入', pattern: /(写入文件|编辑文件|修改文件|创建文件|删除文件)/i },
];

const EXECUTOR_READ_ONLY_RULES: SignalRule[] = [
  { label: 'git状态', pattern: /(?:\bgit status\b|git\s*状态|查看.*git.*状态|看(?:下|看).*git.*状态|查一下.*git.*状态)/i },
  { label: 'git分支', pattern: /(?:\bgit branch\b|当前分支|分支是什么|当前.*git.*分支)/i },
  { label: 'git日志', pattern: /(?:\bgit log\b|最近.*提交|提交记录|最近几条提交)/i },
  { label: '读取文件', pattern: /(读取文件|查看文件|打开文件)/i },
  { label: '搜索文本', pattern: /(搜索文本|查找字符串|搜索[:：]?)/i },
];

const EXECUTOR_MUTATING_RULES: SignalRule[] = [
  { label: 'git pull', pattern: /\bgit pull\b/i },
  { label: 'git fetch', pattern: /\bgit fetch\b/i },
  { label: 'bare pull/fetch', pattern: /\b(pull|fetch)\b/i },
  { label: '文件写操作', pattern: /(写入文件|编辑文件|修改文件|创建文件|删除文件)/i },
];

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function collectLabels(text: string, rules: SignalRule[]): string[] {
  return uniq(rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label));
}

function makeSignals(text: string, rules: {
  query?: SignalRule[];
  action?: SignalRule[];
  object?: SignalRule[];
  context?: SignalRule[];
  system?: SignalRule[];
  explain?: SignalRule[];
  readOnly?: SignalRule[];
  mutating?: SignalRule[];
}): MatchedSignals {
  return {
    query: collectLabels(text, rules.query || []),
    action: collectLabels(text, rules.action || []),
    object: collectLabels(text, rules.object || []),
    context: collectLabels(text, rules.context || []),
    system: collectLabels(text, rules.system || []),
    explain: collectLabels(text, rules.explain || EXPLAIN_RULES),
    readOnly: collectLabels(text, rules.readOnly || []),
    mutating: collectLabels(text, rules.mutating || []),
  };
}

function toExecutionRisk(signals: MatchedSignals): ExecutionRisk {
  if (signals.mutating.length > 0) return 'mutating';
  if (signals.readOnly.length > 0) return 'read_only';
  return 'none';
}

function makeAssessment(signals: MatchedSignals): FastPathInteractionAssessment {
  const hasQuery = signals.query.length > 0;
  const hasAction = signals.action.length > 0;
  const hasReference = signals.object.length > 0 || signals.context.length > 0 || signals.system.length > 0;
  const risk = toExecutionRisk(signals);

  if (signals.explain.length > 0 && !hasQuery && !hasAction && !hasReference && risk === 'none') {
    return { interactionIntent: 'explain', executionRisk: risk, matchedSignals: signals };
  }
  if (hasAction) {
    return { interactionIntent: 'action', executionRisk: risk, matchedSignals: signals };
  }
  if (hasQuery) {
    return { interactionIntent: 'query', executionRisk: risk, matchedSignals: signals };
  }
  if (risk === 'read_only') {
    return { interactionIntent: 'query', executionRisk: risk, matchedSignals: signals };
  }
  if (hasReference) {
    return { interactionIntent: risk === 'mutating' ? 'ambiguous' : 'query', executionRisk: risk, matchedSignals: signals };
  }
  if (signals.explain.length > 0) {
    return { interactionIntent: 'explain', executionRisk: risk, matchedSignals: signals };
  }
  return { interactionIntent: risk === 'mutating' ? 'ambiguous' : 'query', executionRisk: risk, matchedSignals: signals };
}

export function assessIgnisInteraction(prompt: string, hasFiles: boolean): FastPathInteractionAssessment {
  const text = prompt.trim();
  const signals = makeSignals(text, {
    query: [...GENERIC_QUERY_RULES, ...IGNIS_QUERY_RULES],
    action: [...GENERIC_ACTION_RULES, ...IGNIS_ACTION_RULES],
    object: IGNIS_OBJECT_RULES,
    context: IGNIS_CONTEXT_RULES,
    system: IGNIS_SYSTEM_RULES,
    readOnly: IGNIS_READ_ONLY_RULES,
    mutating: hasFiles
      ? [...IGNIS_MUTATING_RULES, { label: '附件参考生成', pattern: /(基于|参考|用这|复刻|风格|视频|模型|原画|图片|图像)/i }]
      : IGNIS_MUTATING_RULES,
  });
  const assessment = makeAssessment(signals);
  if (
    assessment.interactionIntent === 'action'
    && signals.query.length > 0
    && signals.readOnly.length > 0
    && signals.mutating.length === 0
  ) {
    return { ...assessment, interactionIntent: 'query' };
  }
  if (assessment.interactionIntent === 'ambiguous') {
    return { ...assessment, interactionIntent: 'query' };
  }
  return assessment;
}

export function assessMcpInteraction(prompt: string): FastPathInteractionAssessment {
  const text = prompt.trim();
  const signals = makeSignals(text, {
    query: [...GENERIC_QUERY_RULES, ...MCP_QUERY_RULES],
    action: [...GENERIC_ACTION_RULES, ...MCP_ACTION_RULES],
    object: MCP_OBJECT_RULES,
    system: MCP_SYSTEM_RULES,
    readOnly: MCP_READ_ONLY_RULES,
    mutating: MCP_MUTATING_RULES,
  });
  const assessment = makeAssessment(signals);
  if (
    assessment.interactionIntent === 'action'
    && signals.query.length > 0
    && signals.readOnly.length > 0
    && signals.mutating.length === 0
  ) {
    return { ...assessment, interactionIntent: 'query' };
  }
  if (assessment.interactionIntent === 'ambiguous') {
    return { ...assessment, interactionIntent: 'query' };
  }
  return assessment;
}

export function assessExecutorInteraction(prompt: string): FastPathInteractionAssessment {
  const text = prompt.trim();
  const signals = makeSignals(text, {
    query: [...GENERIC_QUERY_RULES, ...EXECUTOR_QUERY_RULES],
    action: EXECUTOR_ACTION_RULES,
    object: EXECUTOR_OBJECT_RULES,
    readOnly: EXECUTOR_READ_ONLY_RULES,
    mutating: EXECUTOR_MUTATING_RULES,
  });
  const assessment = makeAssessment(signals);
  if (assessment.interactionIntent === 'ambiguous') {
    return { ...assessment, interactionIntent: 'query' };
  }
  return assessment;
}

export function canExecuteMutatingFastPath(assessment: FastPathInteractionAssessment): boolean {
  return assessment.interactionIntent === 'action';
}

export function getExecutorCommandRisk(command: string): ExecutionRisk {
  const text = command.trim();
  if (collectLabels(text, EXECUTOR_MUTATING_RULES).length > 0) return 'mutating';
  if (collectLabels(text, EXECUTOR_READ_ONLY_RULES).length > 0) return 'read_only';
  return 'none';
}

function isIgnisHistoryIntent(prompt: string, mentionsIgnis: boolean): boolean {
  if (!mentionsIgnis && !/(turn_id|turn_|session_id|canvas|file_id|上一个|上一轮|上一版|刚才)/i.test(prompt)) return false;
  return /(历史|history|最近几次|最近几轮|最近记录|最近列表|最近任务|最近会话|整理成列表|整理列表|列出来|列个表|列表发我|汇总成列表|汇总列表)/i.test(prompt);
}

function isIgnisStatusIntent(prompt: string, mentionsIgnis: boolean): boolean {
  if (!mentionsIgnis) return false;
  if (isIgnisHistoryIntent(prompt, mentionsIgnis)) return false;
  const directStatusPattern = /(安装|装好|配置|配好|接入|部署|可用|能用|状态|在线|离线|连通|连接|健康|启动|运行|ready)/i;
  const checkedStatusPattern = /(检查|确认|看看|看下|看一眼).*(安装|配置|状态|连通|在线|可用|能用|启动|运行|健康)/i;
  const questionStatusPattern = /(启动|运行).{0,4}(了吗|了没|没|好了吗)/i;
  return directStatusPattern.test(prompt) || checkedStatusPattern.test(prompt) || questionStatusPattern.test(prompt);
}

function isIgnisReplayRequest(prompt: string): boolean {
  const hasTargetObject = /(结果|文件|图片|图|模型|素材)/i.test(prompt);
  if (!hasTargetObject) return false;
  const resendPattern = /(再发|重发|补发|重新发|再给我|发我一下|发我一份|重新给我)/i;
  const priorPattern = /(上次|上一个|上一轮|上一版|刚才|之前|前面|上回|最近)/i;
  const fetchPattern = /(发我|给我|回传|查|查询|看|获取|刷新)/i;
  return resendPattern.test(prompt) || (priorPattern.test(prompt) && fetchPattern.test(prompt));
}

function isIgnisResultIntent(prompt: string, referencesIgnisState: boolean): boolean {
  if (isIgnisReplayRequest(prompt)) return true;
  if (!referencesIgnisState) return false;
  return /(查|查询|看|获取|刷新).*(结果|进度)|\bresult\b|(?:再发|重发|补发|重新发|再给我|发我一下|发我一份|把.*发我).*(结果|文件|图片|图|模型|素材)|(?:上次|上一个|上一轮|上一版|刚才|之前|前面|上回).*(结果|文件|图片|图|模型|素材)/i.test(prompt);
}

export function inferIgnisFastIntent(
  prompt: string,
  hasFiles: boolean,
  assessment = assessIgnisInteraction(prompt, hasFiles),
): IgnisFastIntent | null {
  const text = prompt.trim();
  const mentionsIgnis = /ignis/i.test(text);
  const referencesIgnisState = mentionsIgnis || /(turn_id|turn_|session_id|canvas|file_id|上一个|上一轮|上一版|刚才|上次|之前|前面|上回)/i.test(text);
  const generationPattern = /(生成|画|绘制|做|制作|创建|出图|出一张|图片|图像|原画|概念图|分镜|视频|模型|3d模型|3d model|文生图|图生图|图生视频|文生视频|复刻|参考|风格|继续上一版|延续上一轮|改一下|换成|调整|再来)/i;
  const creativeObjectPattern = /(图片|图像|原画|概念图|分镜|视频|模型|3d|素材|asset)/i;
  const queryLike = assessment.interactionIntent === 'query' || assessment.interactionIntent === 'ambiguous';

  if (mentionsIgnis && /(skills|技能列表|有哪些技能|列出.*技能)/i.test(text)) return 'skills';
  if (queryLike && isIgnisHistoryIntent(text, mentionsIgnis)) return 'history';
  if (queryLike && isIgnisStatusIntent(text, mentionsIgnis) && !generationPattern.test(text)) return 'status';
  if (queryLike && /(等待|等.*完成|生成完|出图了没|出图了吗|好了没|好了吗|进度|\bwait\b)/i.test(text) && referencesIgnisState && (/(turn_id|turn_|session_id|canvas|file_id)/i.test(text) || generationPattern.test(text))) return 'wait';
  if (queryLike && isIgnisResultIntent(text, referencesIgnisState)) return 'result';
  if (assessment.interactionIntent === 'action' && /(resume|继续回答|选择第|选第|回答)/i.test(text) && referencesIgnisState) return 'resume';

  if (assessment.interactionIntent === 'action') {
    if ((mentionsIgnis && generationPattern.test(text)) || (generationPattern.test(text) && creativeObjectPattern.test(text))) return 'generate';
    if (hasFiles && /(基于|参考|用这|生成|复刻|风格|视频|模型|原画|图片|图像)/i.test(text)) return 'generate';
  }
  if (queryLike && referencesIgnisState && /(turn_id|turn_|session_id|canvas|file_id)/i.test(text)) return 'result';
  return null;
}

export function inferMcpFastIntent(
  prompt: string,
  assessment = assessMcpInteraction(prompt),
): McpFastIntent | null {
  const text = prompt.trim();
  const mentionsMcp = MCP_SYSTEM_RULES.some((rule) => rule.pattern.test(text));
  if (!mentionsMcp) return null;
  if (assessment.interactionIntent === 'explain') return null;
  const asksDomainWork = MCP_DOMAIN_WORK_RULES.some((rule) => rule.pattern.test(text));
  const directStatusPattern = /(状态|连接|在线|离线|健康|连通|可用|能用|启动了吗|运行了吗|帮助|工具列表|有哪些工具|tools\/list)/i;
  const simpleStatusPattern = /^(?:帮我|请)?\s*(?:看看|看下|看一眼|检查一下|检查)\s*(?:一下)?\s*(?:mcp|unity\s*mcp|blender\s*mcp|picture\s*mcp|prefab\s*mcp|ignis\s*mcp|unitymcp|blendermcp|picturemcp|prefabmcp|ignismcp)\s*(?:状态)?\s*$/i;
  if (assessment.interactionIntent === 'action') {
    if (/(启动|拉起|连接|重启)/i.test(text)) return 'start';
    if (/(停止|关闭)/i.test(text)) return 'stop';
    if (/(调用\s+.*?mcp\s*工具|tool call|tools\/call)/i.test(text)) return 'tool_call';
  }
  if (/(工具列表|列出.*工具|有哪些工具|tools\/list)/i.test(text)) return 'list_tools';
  if (asksDomainWork && !directStatusPattern.test(text)) return null;
  if (directStatusPattern.test(text) || simpleStatusPattern.test(text)) return 'status';
  return null;
}
