import type { DecisionAnswer, DecisionResult, DecisionQuestion, DecisionQuestionType } from '../host.js';

export interface DecisionViewInput {
  title?: string;
  state?: string;
  questions: readonly DecisionQuestion[];
  result: DecisionResult;
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

function answerHeadline(answer: DecisionAnswer, question?: DecisionQuestion): string {
  if (answer.type === 'noul') return `是概率 **${percent(answer.noul)}**`;
  if (answer.type === 'choice') return `选择 **${text(answer.choice, 80) || '未返回'}**`;
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
  const blocks: string[] = [`# ${escapeCell(title)}`];
  if (state) blocks.push(`**状态：**${escapeCell(state)}`);

  for (const answer of input.result.answers.slice(0, 8)) {
    const question = questions.get(answer.id);
    const label = text(question?.instructions, 120) || answer.id;
    const rows = probabilityRows(answer, question);
    const lines = [
      `**${escapeCell(label)}**`,
      answerHeadline(answer, question),
      ...(typeof answer.confidence === 'number' ? [`置信度 **${percent(answer.confidence)}**`] : []),
    ];
    if (rows.length > 0) {
      lines.push('', '| 候选 / 概率 | 概率 |', '| --- | --- |', ...rows.map((row) => {
        const [candidate, probability] = row.split(' | ');
        return `| ${candidate || '—'} | ${probability || '—'} |`;
      }));
    }
    blocks.push(lines.join('\n'));
  }
  if (input.result.answers.length === 0) blocks.push('Jev 未返回可展示的判断结果。');
  return blocks.join('\n\n');
}

export function decisionAnswerTypeLabel(type: DecisionQuestionType): string {
  return type === 'noul' ? '是/否概率' : type === 'choice' ? '分类选择' : '评分分布';
}
