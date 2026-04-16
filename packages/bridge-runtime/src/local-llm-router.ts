import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from './config.js';

const DEFAULT_MAX_INPUT_CHARS = 6000;

export interface LocalRouteDecision {
  useLocal: boolean;
  requestKind: string;
  reason: string;
}

const EXCLUDE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(unity|blender|mcp|prefab|timeline)\b/i, reason: '包含 Unity/Blender/MCP 相关请求' },
  { pattern: /(飞书文档|feishu doc|docx|云文档|lark doc)/i, reason: '文档生成类请求' },
  { pattern: /(截图|图片|image|附件|上传图片|发图)/i, reason: '包含图片或附件处理' },
  { pattern: /(git pull|git push|rebase|merge|pull request|发布|一键发布|commit)/i, reason: 'Git 或发布类请求' },
  { pattern: /(删除|删库|清空|重置|改代码|修改仓库|apply_patch|编辑文件|写入文件)/i, reason: '高危或写操作请求' },
  { pattern: /(多文件|整个项目|全仓|项目级|架构改造|复杂排障)/i, reason: '复杂项目级请求' },
];

const INCLUDE_PATTERNS: Array<{ pattern: RegExp; kind: string; reason: string }> = [
  { pattern: /(powershell|bash|shell|cmd|python|typescript|ts|node|git 命令|正则|regex|命令行|命令生成)/i, kind: 'command', reason: '命令生成类请求' },
  { pattern: /(日志|报错|错误|warning|stack trace|异常总结|故障分类|错误解释)/i, kind: 'log-summary', reason: '日志总结类请求' },
  { pattern: /\b(json|yaml|yml|toml|env)\b|配置文件|配置项/i, kind: 'config-help', reason: '配置解释类请求' },
  { pattern: /(写一个.*脚本|生成.*脚本|小脚本|模板脚本|单文件脚本)/i, kind: 'script-draft', reason: '小脚本生成类请求' },
  { pattern: /(解释.*函数|解释.*代码|这段代码|这个函数|局部重写|轻量重写)/i, kind: 'code-explain', reason: '轻量代码解释类请求' },
];

function totalHistoryChars(params: StreamChatParams): number {
  return (params.conversationHistory || []).reduce((sum, item) => sum + item.content.length, 0);
}

function buildInputText(params: StreamChatParams): string {
  return [
    params.prompt || '',
    ...(params.conversationHistory || []).slice(-4).map((item) => item.content || ''),
  ].join('\n');
}

export function decideLocalRoute(params: StreamChatParams, config: Config): LocalRouteDecision {
  if (config.localLlmEnabled !== true) {
    return { useLocal: false, requestKind: 'disabled', reason: '本地模型未启用' };
  }
  if (config.localLlmAutoRoute === false) {
    return { useLocal: false, requestKind: 'disabled', reason: '自动分流已关闭' };
  }
  if (params.files && params.files.length > 0) {
    return { useLocal: false, requestKind: 'excluded', reason: '包含文件附件' };
  }
  if (params.permissionMode === 'acceptEdits') {
    return { useLocal: false, requestKind: 'excluded', reason: '写入模式请求' };
  }

  const input = buildInputText(params);
  const inputLower = input.toLowerCase();
  const maxInputChars = Math.max(1200, config.localLlmMaxInputChars || DEFAULT_MAX_INPUT_CHARS);
  if (input.length > maxInputChars) {
    return { useLocal: false, requestKind: 'excluded', reason: `输入过长(${input.length})` };
  }
  if (totalHistoryChars(params) > Math.min(maxInputChars, 3200)) {
    return { useLocal: false, requestKind: 'excluded', reason: '历史上下文过长' };
  }

  for (const exclude of EXCLUDE_PATTERNS) {
    if (exclude.pattern.test(inputLower)) {
      return { useLocal: false, requestKind: 'excluded', reason: exclude.reason };
    }
  }

  for (const include of INCLUDE_PATTERNS) {
    if (include.pattern.test(inputLower)) {
      return { useLocal: true, requestKind: include.kind, reason: include.reason };
    }
  }

  return { useLocal: false, requestKind: 'excluded', reason: '未命中低复杂度规则' };
}
