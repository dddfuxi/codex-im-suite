import type { DecisionQuestion, DecisionResult } from '../../../host.js';
import { buildFeishuCardHeroElement } from './card-hero.js';
import { renderDecisionView } from '../../../application/decision-view.js';
import type { FeishuCardHeroImage } from '../../../types.js';

export interface FeishuDecisionCardInput {
  title?: string;
  state?: string;
  questions: readonly DecisionQuestion[];
  result: DecisionResult;
  cardHero?: FeishuCardHeroImage;
}

/** Jev 结果专用只读卡片；它没有 callback，不能被误当成用户选择卡。 */
export function buildFeishuDecisionCard(input: FeishuDecisionCardInput): string {
  const elements: Array<Record<string, unknown>> = [];
  if (input.cardHero) elements.push(buildFeishuCardHeroElement(input.cardHero));
  // The Card 2.0 header already contains the title.  Suppress the Markdown
  // heading so mobile users do not see "Jev ..." twice in the same card.
  elements.push({
    tag: 'markdown',
    content: renderDecisionView({ ...input, showTitle: false, visualProbabilityBars: true }),
  });
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: input.title?.trim() || '结构化判断' },
    },
    body: { elements },
  });
}
