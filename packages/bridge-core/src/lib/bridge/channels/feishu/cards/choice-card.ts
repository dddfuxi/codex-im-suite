import type { FeishuCardHeroImage } from '../../../types.js';
import { buildFeishuCardHeroElement } from './card-hero.js';

export interface FeishuChoiceCardOption {
  label: string;
  description?: string;
  callbackData: string;
  type?: 'default' | 'primary' | 'danger';
  count?: number;
}

export interface FeishuChoiceCardInput {
  title?: string;
  prompt: string;
  options: readonly FeishuChoiceCardOption[];
  footer?: string;
  template?: 'blue' | 'green' | 'purple' | 'red' | 'grey';
  cardHero?: FeishuCardHeroImage;
  choiceMode?: 'single_user' | 'vote' | 'claim' | 'parallel';
  closesAt?: number;
  participantCount?: number;
  eligibleParticipantCount?: number;
  finalized?: boolean;
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/([*_`\[\]<>])/gu, '\\$1')
    .trim();
}

/**
 * 飞书有限选项统一使用同一张 Card 2.0：标题、问题、纵向说明和真实按钮。
 * callbackData 必须由 Bridge 生成，不能直接接收模型提供的平台动作值。
 */
export function buildFeishuChoiceCard(input: FeishuChoiceCardInput): string {
  const elements: Array<Record<string, unknown>> = [];
  if (input.cardHero) elements.push(buildFeishuCardHeroElement(input.cardHero));
  elements.push({
    tag: 'markdown',
    content: input.prompt.trim() || '请选择一个选项。',
  }, { tag: 'hr' });

  if (input.choiceMode && input.choiceMode !== 'single_user') {
    const modeLabel = input.choiceMode === 'vote'
      ? '全员投票'
      : input.choiceMode === 'claim'
        ? '全员抢选'
        : '多人分线';
    const statusParts = [
      `**模式：**${modeLabel}`,
      input.participantCount !== undefined
        ? input.eligibleParticipantCount !== undefined
          ? `**进度：**${Math.max(0, input.participantCount)} / ${Math.max(0, input.eligibleParticipantCount)} 人`
          : `**已参与：**${Math.max(0, input.participantCount)} 人`
        : '',
      input.closesAt ? `**截止：**<text_tag color='blue'>${formatChoiceDeadline(input.closesAt)}</text_tag>` : '',
      input.finalized ? "<text_tag color='grey'>本轮已结束</text_tag>" : '',
    ].filter(Boolean);
    elements.push({ tag: 'markdown', content: statusParts.join('　') }, { tag: 'hr' });
  }

  for (const option of input.options) {
    const countSuffix = input.choiceMode === 'vote' && option.count !== undefined ? `（${option.count} 票）` : '';
    if (option.description?.trim()) {
      elements.push({
        tag: 'markdown',
        content: `**${escapeMarkdownText(option.label)}${countSuffix}**\n${escapeMarkdownText(option.description)}`,
      });
    } else if (input.finalized || countSuffix) {
      elements.push({ tag: 'markdown', content: `**${escapeMarkdownText(option.label)}${countSuffix}**` });
    }
    if (!input.finalized) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `${option.label.trim()}${countSuffix}`.slice(0, 48) },
        type: option.type || 'primary',
        size: 'medium',
        value: { callback_data: option.callbackData },
      });
    }
  }

  if (input.footer?.trim()) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: input.footer.trim() });
  }

  return JSON.stringify({
    schema: '2.0',
    // 飞书 im.message.patch 只允许更新显式开启 update_multi 的共享卡片。
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: input.template || 'blue',
      title: { tag: 'plain_text', content: input.title?.trim() || '请选择' },
    },
    body: { elements },
  });
}

function formatChoiceDeadline(timestamp: number): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return '即将结束';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}
