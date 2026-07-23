export type WorkflowFailureCategory =
  | 'empty'
  | 'authentication'
  | 'usage_limit'
  | 'provider_protocol'
  | 'invalid_request'
  | 'cancelled'
  | 'transient'
  | 'unknown';

export interface WorkflowFailureRetryDecision {
  category: WorkflowFailureCategory;
  autoRetry: boolean;
  reasonCode:
    | 'empty_failure_retry_once'
    | 'authentication_requires_user_action'
    | 'usage_limit_requires_user_action'
    | 'provider_protocol_requires_configuration'
    | 'invalid_request_requires_correction'
    | 'cancelled_must_not_restart'
    | 'transient_failure_retry_once'
    | 'unknown_failure_retry_once';
}

interface WorkflowFailureRule {
  category: Exclude<WorkflowFailureCategory, 'empty' | 'unknown'>;
  autoRetry: boolean;
  reasonCode: WorkflowFailureRetryDecision['reasonCode'];
  patterns: readonly RegExp[];
}

const WORKFLOW_FAILURE_RULES: readonly WorkflowFailureRule[] = [
  {
    category: 'authentication',
    autoRetry: false,
    reasonCode: 'authentication_requires_user_action',
    patterns: [
      /\b401\b[^\n]*unauthorized/iu,
      /\bunauthorized\b/iu,
      /refresh\s*token/iu,
      /authentication\s*token/iu,
      /authentication\s*(?:failed|failure|required)/iu,
      /not\s+logged\s+in/iu,
      /please\s+(?:run\s+\/login|log\s+in|login)/iu,
      /invalid\s+(?:api[ _-]?)?key/iu,
      /登录(?:已)?失效/iu,
      /重新登录/iu,
      /认证(?:失败|失效|过期)/iu,
    ],
  },
  {
    category: 'usage_limit',
    autoRetry: false,
    reasonCode: 'usage_limit_requires_user_action',
    patterns: [
      /usage\s*limit/iu,
      /insufficient[_\s-]*quota/iu,
      /quota\s+(?:exceeded|exhausted)/iu,
      /额度(?:不足|已用尽)/iu,
      /用量(?:上限|已用尽)/iu,
    ],
  },
  {
    category: 'provider_protocol',
    autoRetry: false,
    reasonCode: 'provider_protocol_requires_configuration',
    patterns: [
      /method\s+not\s+allowed/iu,
      /unexpected\s+status\s+405/iu,
      /\/v1\/responses\b/iu,
      /responses\s+endpoint[^\n]*(?:incompatible|unsupported)/iu,
    ],
  },
  {
    category: 'invalid_request',
    autoRetry: false,
    reasonCode: 'invalid_request_requires_correction',
    patterns: [
      /invalid\s+request\s+parameter/iu,
      /unsupported\s+request\s+parameter/iu,
      /参数(?:无效|不兼容|不支持)/iu,
    ],
  },
  {
    category: 'cancelled',
    autoRetry: false,
    reasonCode: 'cancelled_must_not_restart',
    patterns: [
      /the\s+operation\s+was\s+aborted/iu,
      /\baborterror\b/iu,
      /request\s+(?:was\s+)?aborted/iu,
      /(?:user|operator)\s+(?:cancelled|canceled|aborted)/iu,
      /用户(?:主动)?(?:取消|中止|终止)/iu,
      /已中断/iu,
    ],
  },
  {
    category: 'transient',
    autoRetry: true,
    reasonCode: 'transient_failure_retry_once',
    patterns: [
      /\b429\b/iu,
      /rate\s*limit/iu,
      /\beconnreset\b|\beconnrefused\b|\benotfound\b|\betimedout\b/iu,
      /connection\s+(?:reset|refused)/iu,
      /could\s+not\s+connect/iu,
      /fetch\s+failed/iu,
      /network\s+(?:error|timeout)/iu,
      /\b(?:502|503|504)\b/iu,
      /service\s+unavailable/iu,
    ],
  },
];

function collectWorkflowFailureText(value: unknown, seen = new WeakSet<object>(), depth = 0): string[] {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return [String(value)];
  }
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectWorkflowFailureText(item, seen, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const fields = ['name', 'message', 'code', 'status', 'statusCode', 'error', 'reason', 'cause', 'errors'];
  return fields.flatMap((field) => collectWorkflowFailureText(record[field], seen, depth + 1));
}

export function normalizeWorkflowFailureText(error: unknown): string {
  return collectWorkflowFailureText(error)
    .join('\n')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

/**
 * 自动重试只处理可能自行恢复的失败。认证、配置、参数和主动取消都需要
 * 外部状态变化或用户动作，立即重跑只会重复消耗执行资源并制造重复任务。
 */
export function decideWorkflowFailureRetry(error: unknown): WorkflowFailureRetryDecision {
  const text = normalizeWorkflowFailureText(error);
  if (!text) {
    return {
      category: 'empty',
      autoRetry: true,
      reasonCode: 'empty_failure_retry_once',
    };
  }

  for (const rule of WORKFLOW_FAILURE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return {
        category: rule.category,
        autoRetry: rule.autoRetry,
        reasonCode: rule.reasonCode,
      };
    }
  }

  return {
    category: 'unknown',
    autoRetry: true,
    reasonCode: 'unknown_failure_retry_once',
  };
}
