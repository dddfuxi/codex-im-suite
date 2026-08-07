import type { WorkflowFailureDiagnosticContract } from '@codex-im-suite/contracts';

import { decideWorkflowFailureRetry, normalizeWorkflowFailureText } from './workflow-failure-policy.js';

type WorkflowFailureDiagnostic = WorkflowFailureDiagnosticContract;

const TOOL_DIAGNOSTIC_RULES: ReadonlyArray<{
  category: WorkflowFailureDiagnostic['category'];
  code: string;
  summary: string;
  patterns: readonly RegExp[];
}> = [
  {
    category: 'dependency_unavailable',
    code: 'tool.dependency_path_missing',
    summary: '工具依赖路径不存在或未安装',
    patterns: [
      /cannot\s+find\s+path/iu,
      /no\s+such\s+file\s+or\s+directory/iu,
      /\benoent\b/iu,
      /module\s+not\s+found/iu,
    ],
  },
  {
    category: 'runtime_incompatible',
    code: 'tool.module_loader_incompatible',
    summary: '工具模块加载方式与当前运行时不兼容',
    patterns: [
      /err_unsupported_esm_url_scheme/iu,
      /unsupported\s+esm\s+url\s+scheme/iu,
      /only\s+urls\s+with\s+a\s+scheme/iu,
      /invalid\s+module\s+specifier/iu,
    ],
  },
  {
    category: 'runtime_unavailable',
    code: 'tool.runtime_unavailable',
    summary: '工具所需的宿主运行时或原生 helper 当前不可用',
    patterns: [
      /runtime\s+is\s+unavailable/iu,
      /native\s+pipe\s+path\s+is\s+unavailable/iu,
      /helper[^\n]{0,80}\bunavailable\b/iu,
      /宿主运行时[^\n]{0,40}不可用/iu,
    ],
  },
  {
    category: 'authentication',
    code: 'tool.authentication_required',
    summary: '工具认证已失效或需要人工授权',
    patterns: [
      /\b401\b[^\n]*unauthorized/iu,
      /not\s+logged\s+in/iu,
      /refresh\s*token/iu,
      /重新登录|认证(?:失败|失效|过期)/iu,
    ],
  },
  {
    category: 'transient',
    code: 'tool.transient_network_failure',
    summary: '工具调用遇到瞬时网络或服务不可达',
    patterns: [
      /\beconnreset\b|\beconnrefused\b|\benotfound\b|\betimedout\b/iu,
      /fetch\s+failed|network\s+(?:error|timeout)|service\s+unavailable/iu,
      /\b(?:502|503|504)\b/iu,
    ],
  },
];

function providerDiagnostic(error: unknown): WorkflowFailureDiagnostic | null {
  const decision = decideWorkflowFailureRetry(error);
  if (decision.category === 'empty') return null;
  return {
    source: 'provider',
    category: decision.category,
    code: `provider.${decision.reasonCode}`,
    summary: {
      authentication: 'Provider 认证已失效，需要人工恢复',
      usage_limit: 'Provider 用量或额度不足，需要人工处理',
      provider_protocol: 'Provider 协议或端点配置不兼容',
      invalid_request: 'Provider 请求参数不兼容或无效',
      cancelled: '本轮执行被明确取消或中止',
      transient: 'Provider 遇到可恢复的瞬时失败',
      unknown: 'Provider 返回未分类失败',
    }[decision.category],
    autoRetry: decision.autoRetry,
  };
}

function toolDiagnostic(error: unknown): WorkflowFailureDiagnostic {
  const text = normalizeWorkflowFailureText(error);
  for (const rule of TOOL_DIAGNOSTIC_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return {
        source: 'tool',
        category: rule.category,
        code: rule.code,
        summary: rule.summary,
      };
    }
  }
  return {
    source: 'tool',
    category: 'unknown',
    code: 'tool.unknown_failure',
    summary: '工具调用返回未分类失败',
  };
}

export function mergeWorkflowFailureDiagnostics(
  ...groups: Array<readonly WorkflowFailureDiagnostic[] | undefined>
): WorkflowFailureDiagnostic[] {
  const byCode = new Map<string, WorkflowFailureDiagnostic>();
  for (const diagnostic of groups.flatMap((group) => group || [])) {
    if (!diagnostic?.code || byCode.has(diagnostic.code)) continue;
    byCode.set(diagnostic.code, diagnostic);
  }
  return [...byCode.values()].slice(0, 12);
}

export function diagnoseWorkflowFailures(input: {
  providerError?: unknown;
  toolErrors?: readonly unknown[];
}): WorkflowFailureDiagnostic[] {
  const provider = input.providerError === undefined ? null : providerDiagnostic(input.providerError);
  const tools = (input.toolErrors || []).map(toolDiagnostic);
  return mergeWorkflowFailureDiagnostics(provider ? [provider] : undefined, tools);
}
