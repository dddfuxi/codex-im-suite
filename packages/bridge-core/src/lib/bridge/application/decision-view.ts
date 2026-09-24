import type { DecisionAnswer, DecisionResult, DecisionQuestion, DecisionQuestionType } from '../host.js';

export interface DecisionViewInput {
  title?: string;
  /**
   * Feishu decision cards already render the title in their native header.
   * Keep the Markdown projection title by default for non-card channels, but
   * let card callers suppress it so the same title is not shown twice.
   */
  showTitle?: boolean;
  state?: string;
  questions: readonly DecisionQuestion[];
  result: DecisionResult;
  /** 飞书 Card 2.0 使用紧凑的图标概率条；普通 Markdown 保持兼容表格。 */
  visualProbabilityBars?: boolean;
  /** Pure Jev keeps deterministic intent as a secondary hint below the main result. */
  auxiliaryIntent?: {
    label: string;
    confidence?: number;
  };
}

/**
 * Validate and bound a provider result before it enters a user-visible view.
 *
 * Decision providers are deliberately replaceable, so Core must not trust a
 * provider's labels, probabilities, or question type.  This function keeps
 * only answers that match the questions in the request and have a usable
 * value for their declared type.  It never invents a fallback answer.
 */
export function normalizeDecisionResult(
  result: DecisionResult | null | undefined,
  questions: readonly DecisionQuestion[],
): DecisionResult | null {
  if (!result || (result.provider !== 'jev' && result.provider !== 'custom')) return null;
  if (typeof result.generatedAt !== 'string' || !result.generatedAt.trim()) return null;
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const answers: DecisionAnswer[] = [];
  for (const raw of Array.isArray(result.answers) ? result.answers : []) {
    if (!raw || typeof raw.id !== 'string') continue;
    const question = questionById.get(raw.id);
    if (!question || raw.type !== question.type) continue;
    const answer: DecisionAnswer = { id: raw.id, type: raw.type };
    if (raw.type === 'noul') {
      if (typeof raw.noul === 'number' && Number.isFinite(raw.noul)) {
        answer.noul = Math.max(0, Math.min(1, raw.noul));
      }
      if (answer.noul === undefined && !raw.probabilities) continue;
    } else if (raw.type === 'choice') {
      if (typeof raw.choice === 'string' && raw.choice.trim()) {
        const choice = raw.choice.trim();
        const criteria = question.criteria;
        if (!Array.isArray(criteria) && Object.prototype.hasOwnProperty.call(criteria, choice)) {
          answer.choice = choice.slice(0, 160);
        }
      }
      if (answer.choice === undefined && !raw.probabilities) continue;
    } else {
      if (typeof raw.score === 'number' && Number.isFinite(raw.score)
        && Array.isArray(question.criteria)
        && raw.score >= 0
        && raw.score <= Math.max(0, question.criteria.length - 1)) {
        answer.score = raw.score;
      }
      if (answer.score === undefined && !raw.probabilities) continue;
    }
    if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
      answer.confidence = Math.max(0, Math.min(1, raw.confidence));
    }
    if (raw.probabilities && typeof raw.probabilities === 'object' && !Array.isArray(raw.probabilities)) {
      const probabilities: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw.probabilities)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          probabilities[key.slice(0, 120)] = Math.max(0, Math.min(1, value));
        }
        if (Object.keys(probabilities).length >= 32) break;
      }
      if (Object.keys(probabilities).length > 0) answer.probabilities = probabilities;
      if (answer.type === 'noul' && answer.noul === undefined) {
        const yesProbability = probabilities.yes ?? probabilities.true ?? probabilities['是'];
        if (typeof yesProbability === 'number') answer.noul = yesProbability;
      }
    }
    if (raw.legend && typeof raw.legend === 'object' && !Array.isArray(raw.legend)) {
      const legend: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.legend)) {
        if (typeof value === 'string' && value.trim()) legend[key.slice(0, 120)] = value.trim().slice(0, 120);
        if (Object.keys(legend).length >= 32) break;
      }
      if (Object.keys(legend).length > 0) answer.legend = legend;
    }
    answers.push(answer);
  }
  if (answers.length === 0) return null;
  return {
    provider: result.provider,
    model: typeof result.model === 'string' ? result.model.slice(0, 120) : '',
    answers,
    generatedAt: result.generatedAt.trim().slice(0, 64),
    ...(typeof result.requestId === 'string' && result.requestId.trim() ? { requestId: result.requestId.slice(0, 160) } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, max);
}

function escapeCell(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
}

function percent(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 1000) / 10}%`;
}

function probabilityRows(answer: DecisionAnswer, question?: DecisionQuestion): string[] {
  const probabilities = answer.probabilities || {};
  const keys = Object.keys(probabilities).slice(0, 12);
  if (keys.length === 0 && answer.type === 'noul' && typeof answer.noul === 'number') {
    return [`是 | ${percent(answer.noul)}`, `否 | ${percent(1 - answer.noul)}`];
  }
  const criteria = question?.criteria;
  return keys.map((key) => {
    const criterionLabel = Array.isArray(criteria)
      ? criteria[Number(key)]
      : criteria && typeof criteria === 'object'
        ? criteria[key]
        : undefined;
    const label = criterionLabel || answer.legend?.[key] || key;
    return `${escapeCell(text(label, 80))} | ${percent(probabilities[key])}`;
  });
}

interface ProbabilityDisplayRow {
  label: string;
  value: number;
}

function probabilityDisplayRows(answer: DecisionAnswer, question?: DecisionQuestion): ProbabilityDisplayRow[] {
  const probabilities = answer.probabilities || {};
  const keys = Object.keys(probabilities).slice(0, 12);
  if (keys.length === 0 && answer.type === 'noul' && typeof answer.noul === 'number') {
    return [
      { label: '是', value: answer.noul },
      { label: '否', value: 1 - answer.noul },
    ];
  }
  const criteria = question?.criteria;
  return keys.map((key) => {
    const criterionLabel = Array.isArray(criteria)
      ? criteria[Number(key)]
      : criteria && typeof criteria === 'object'
        ? criteria[key]
        : undefined;
    return {
      label: text(criterionLabel || answer.legend?.[key] || key, 80) || '未命名候选',
      value: Math.max(0, Math.min(1, probabilities[key] || 0)),
    };
  });
}

function probabilityBar(value: number): string {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const filled = Math.round(bounded * 10);
  return `${'🟦'.repeat(filled)}${'⬜'.repeat(10 - filled)}`;
}

function rankIcon(index: number): string {
  return index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '▫️';
}

function criterionLabel(answer: DecisionAnswer, question?: DecisionQuestion): string {
  const key = text(answer.choice, 80);
  if (!key) return '';
  const criteria = question?.criteria;
  if (Array.isArray(criteria)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < criteria.length) {
      return text(criteria[index], 80) || key;
    }
  }
  if (criteria && !Array.isArray(criteria) && Object.prototype.hasOwnProperty.call(criteria, key)) {
    return text(criteria[key], 80) || key;
  }
  return text(answer.legend?.[key], 80) || key;
}

function visibleQuestionLabel(instructions: string): string {
  const prefixes = [
    '识别这条消息在当前对话中的主要意图：',
    '判断这条消息所涉及的命题是否成立或可接受：',
    '评估这条消息表达的程度或满意度：',
  ];
  const prefix = prefixes.find((candidate) => instructions.startsWith(candidate));
  const withoutPrefix = prefix ? instructions.slice(prefix.length) : instructions;
  return withoutPrefix.split('。结合相关上下文：', 1)[0] || withoutPrefix;
}

function answerHeadline(answer: DecisionAnswer, question?: DecisionQuestion): string {
  if (answer.type === 'noul') return `是概率 **${percent(answer.noul)}**`;
  if (answer.type === 'choice') return `选择 **${criterionLabel(answer, question) || '未返回'}**`;
  const score = typeof answer.score === 'number' && Number.isFinite(answer.score) ? String(Math.round(answer.score * 100) / 100) : '—';
  const legend = typeof answer.score === 'number' && question?.type === 'score' && Array.isArray(question.criteria)
    ? text(question.criteria[Math.round(answer.score)] || '', 80)
    : '';
  return legend ? `评分 **${score}**（${legend}）` : `评分 **${score}**`;
}

/** 将 Jev 的只读判断结果投影为适合飞书移动端的 Markdown。 */
export function renderDecisionView(input: DecisionViewInput): string {
  const title = text(input.title, 80) || '结构化判断';
  const state = text(input.state, 240);
  const questions = new Map(input.questions.map((question) => [question.id, question]));
  const blocks: string[] = input.showTitle === false ? [] : [`# ${escapeCell(title)}`];

  // The state is often the exact question sent to Jev.  Showing both the
  // state line and the question heading made pure-mode cards look as though
  // the model had returned the same text twice.  Keep the question heading
  // as the canonical display and only show state when it adds context.
  const stateIsQuestion = state.length > 0 && input.result.answers.some((answer) => (
    text(visibleQuestionLabel(questions.get(answer.id)?.instructions || ''), 240) === state
  ));
  if (state && !stateIsQuestion) blocks.push(`**状态：** ${escapeCell(state)}`);
  for (const answer of input.result.answers.slice(0, 8)) {
    const question = questions.get(answer.id);
    const label = text(question ? visibleQuestionLabel(question.instructions) : '', 120) || answer.id;
    const rows = probabilityRows(answer, question);
    const lines = [
      `**${escapeCell(label)}**`,
      answerHeadline(answer, question),
      ...(typeof answer.confidence === 'number' ? [`置信度 **${percent(answer.confidence)}**`] : []),
    ];
    if (rows.length > 0) {
      if (input.visualProbabilityBars) {
        const visualRows = probabilityDisplayRows(answer, question)
          .sort((left, right) => right.value - left.value)
          .map((row, index) => `| ${rankIcon(index)} ${escapeCell(row.label)} | **${percent(row.value)}** | ${probabilityBar(row.value)} |`);
        lines.push('', '| 候选 | 概率 | 分布 |', '| --- | ---: | --- |', ...visualRows);
      } else {
        lines.push('', '| 候选 / 概率 | 概率 |', '| --- | --- |', ...rows.map((row) => {
          const [candidate, probability] = row.split(' | ');
          return `| ${candidate || '—'} | ${probability || '—'} |`;
        }));
      }
    }
    blocks.push(lines.join('\n'));
  }
  if (input.auxiliaryIntent?.label?.trim()) {
    const confidence = typeof input.auxiliaryIntent.confidence === 'number'
      ? `（${percent(input.auxiliaryIntent.confidence)}）`
      : '';
    blocks.push(`**辅助意图：** ${escapeCell(text(input.auxiliaryIntent.label, 80))}${confidence}`);
  }
  if (input.result.answers.length === 0) blocks.push('Jev 未返回可展示的判断结果。');
  return blocks.join('\n\n');
}

export function decisionAnswerTypeLabel(type: DecisionQuestionType): string {
  return type === 'noul' ? '是/否概率' : type === 'choice' ? '分类选择' : '评分分布';
}
