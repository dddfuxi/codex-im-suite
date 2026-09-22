/**
 * Shared, provider-neutral contracts for structured decisions.
 *
 * Jev's Decisions API is one implementation. Its HTTP envelope and model
 * metadata must be translated at the Runtime boundary before these types are
 * passed to Core or a channel renderer.
 */
export const DECISION_REQUEST_PROTOCOL = 'cti-decision-request/v1' as const;
export const DECISION_RESULT_PROTOCOL = 'cti-decision-result/v1' as const;
export const DECISION_VIEW_PROTOCOL = 'cti-decision-view/v1' as const;

export type DecisionQuestionType = 'noul' | 'choice' | 'score';
export type DecisionProvider = 'jev' | 'custom';
export type DecisionProviderMode = 'off' | 'jev';
/** Runtime participation mode; shadow observes only, assist may provide a bounded hint to Primary. */
export type DecisionOperationMode = 'off' | 'shadow' | 'assist';
/** Whether Decision results are exposed to users; this does not select a card implementation. */
export type DecisionResponseMode = 'off' | 'explicit' | 'auto';

export interface DecisionQuestionContract {
  id: string;
  type: DecisionQuestionType;
  instructions: string;
  /** choice uses a label map; score uses an ordered list of descriptions. */
  criteria: Record<string, string> | string[];
}

export interface DecisionRequestContract {
  protocol: typeof DECISION_REQUEST_PROTOCOL;
  requestId: string;
  state: string;
  questions: DecisionQuestionContract[];
  evidenceRefs: string[];
  requestedAt: string;
}

export interface DecisionAnswerContract {
  id: string;
  type: DecisionQuestionType;
  /** Probability of “yes” for noul. */
  noul?: number;
  /** Selected category for choice. */
  choice?: string;
  /** Selected score for score. */
  score?: number;
  confidence?: number;
  /** Probability distribution keyed by category or score. */
  probabilities?: Record<string, number>;
  /** Optional display labels for distribution keys. */
  legend?: Record<string, string>;
}

export interface DecisionUsageContract {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface DecisionResultContract {
  protocol: typeof DECISION_RESULT_PROTOCOL;
  provider: DecisionProvider;
  model: string;
  answers: DecisionAnswerContract[];
  requestId?: string;
  usage?: DecisionUsageContract;
  generatedAt: string;
  errorCode?: string;
  errorSummary?: string;
}

/** Channel-neutral read-only view. It contains no callbacks, Card JSON, or platform IDs. */
export interface DecisionViewContract {
  protocol: typeof DECISION_VIEW_PROTOCOL;
  title: string;
  state?: string;
  /** Optional source-kind label for a homogeneous view; it remains presentation metadata. */
  providerKind?: DecisionQuestionType;
  questions: DecisionQuestionContract[];
  result: DecisionResultContract;
}
