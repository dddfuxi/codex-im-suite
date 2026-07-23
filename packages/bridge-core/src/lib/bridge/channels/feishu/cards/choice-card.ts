export interface FeishuChoiceCardOption {
  label: string;
  description?: string;
  callbackData: string;
  type?: 'default' | 'primary' | 'danger';
}

export interface FeishuChoiceCardInput {
  title?: string;
  prompt: string;
  options: readonly FeishuChoiceCardOption[];
  footer?: string;
  template?: 'blue' | 'green' | 'purple' | 'red' | 'grey';
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
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: input.prompt.trim() || '请选择一个选项。',
    },
    { tag: 'hr' },
  ];

  for (const option of input.options) {
    if (option.description?.trim()) {
      elements.push({
        tag: 'markdown',
        content: `**${escapeMarkdownText(option.label)}**\n${escapeMarkdownText(option.description)}`,
      });
    }
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: option.label.trim().slice(0, 48) },
      type: option.type || 'primary',
      size: 'medium',
      value: { callback_data: option.callbackData },
    });
  }

  if (input.footer?.trim()) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: input.footer.trim() });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: input.template || 'blue',
      title: { tag: 'plain_text', content: input.title?.trim() || '请选择' },
    },
    body: { elements },
  });
}
