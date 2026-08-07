import type { FeishuCardHeroImage } from '../../../types.js';

/** 构造 Card 2.0 横幅头图；imageKey 只能来自 adapter 的真实上传回执。 */
export function buildFeishuCardHeroElement(hero: FeishuCardHeroImage): Record<string, unknown> {
  return {
    tag: 'img',
    img_key: hero.imageKey,
    alt: { tag: 'plain_text', content: hero.alt.trim().slice(0, 120) || '卡片头图' },
    scale_type: 'crop_center',
    // Card JSON 2.0 已移除 stretch_without_padding；负横向 margin 是官方通栏方案。
    margin: '4px -12px',
    preview: true,
  };
}

/**
 * 为平台兼容降级移除 Bridge 本轮上传的头图，但保留正文、按钮和其它图片。
 * 仅接受根元素首项与真实上传 imageKey 精确匹配的卡片，避免误删业务图片。
 */
export function buildFeishuCardWithoutHero(
  cardJson: string,
  hero: FeishuCardHeroImage,
): string | null {
  try {
    const card = JSON.parse(cardJson) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const elements = card.body?.elements;
    const first = elements?.[0];
    if (!Array.isArray(elements)
      || first?.tag !== 'img'
      || first.img_key !== hero.imageKey) {
      return null;
    }
    card.body!.elements = elements.slice(1);
    return JSON.stringify(card);
  } catch {
    return null;
  }
}
