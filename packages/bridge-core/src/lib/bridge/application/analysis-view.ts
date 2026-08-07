export type AnalysisViewTone = 'positive' | 'negative' | 'warning' | 'neutral' | 'info';

export interface AnalysisViewMetric {
  label: string;
  value: string;
  change?: string;
  tone?: AnalysisViewTone;
}

export interface AnalysisViewSection {
  title: string;
  items: string[];
  tone?: AnalysisViewTone;
}

/** 模型只提供可见分析内容；颜色等平台表现由 Delivery Layer 映射。 */
export interface AnalysisView {
  title: string;
  verdict: string;
  tone: AnalysisViewTone;
  metrics: AnalysisViewMetric[];
  sections: AnalysisViewSection[];
}

const TONES = new Set<AnalysisViewTone>(['positive', 'negative', 'warning', 'neutral', 'info']);

function compactVisibleText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function parseTone(value: unknown, fallback: AnalysisViewTone = 'neutral'): AnalysisViewTone {
  return typeof value === 'string' && TONES.has(value.trim().toLowerCase() as AnalysisViewTone)
    ? value.trim().toLowerCase() as AnalysisViewTone
    : fallback;
}

function normalizeVisibleKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function appendUniqueVisibleText(target: string[], candidates: unknown[], maxItems: number): void {
  const seen = new Set(target.map(normalizeVisibleKey));
  for (const candidate of candidates) {
    const text = compactVisibleText(candidate, 180);
    const key = normalizeVisibleKey(text);
    if (!text || !key || seen.has(key)) continue;
    target.push(text);
    seen.add(key);
    if (target.length >= maxItems) break;
  }
}

/**
 * 清洗通用看盘式分析视图。数量和长度在协议入口统一收口，避免卡片过长，
 * 同时不接受模型提供的 Card JSON、颜色值、回调或平台字段。
 */
export function parseAnalysisView(candidate: unknown): AnalysisView | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const raw = candidate as Record<string, unknown>;
  const title = compactVisibleText(raw.title, 64);
  const verdict = compactVisibleText(raw.verdict, 240);
  if (!title || !verdict) return undefined;

  const metrics: AnalysisViewMetric[] = [];
  const metricLabels = new Set<string>();
  if (Array.isArray(raw.metrics)) {
    // 先过滤再计入展示上限，避免无效或重复项挤掉后面的真实指标；扫描量仍受限。
    for (const candidateMetric of raw.metrics.slice(0, 24)) {
      if (!candidateMetric || typeof candidateMetric !== 'object' || Array.isArray(candidateMetric)) continue;
      const metric = candidateMetric as Record<string, unknown>;
      const label = compactVisibleText(metric.label, 32);
      const value = compactVisibleText(metric.value, 48);
      const labelKey = normalizeVisibleKey(label);
      if (!label || !value || !labelKey || metricLabels.has(labelKey)) continue;
      const change = compactVisibleText(metric.change, 48);
      metrics.push({
        label,
        value,
        ...(change ? { change } : {}),
        ...(metric.tone === undefined ? {} : { tone: parseTone(metric.tone) }),
      });
      metricLabels.add(labelKey);
      if (metrics.length >= 6) break;
    }
  }

  const sections: AnalysisViewSection[] = [];
  const sectionByTitle = new Map<string, AnalysisViewSection>();
  if (Array.isArray(raw.sections)) {
    for (const candidateSection of raw.sections.slice(0, 16)) {
      if (!candidateSection || typeof candidateSection !== 'object' || Array.isArray(candidateSection)) continue;
      const section = candidateSection as Record<string, unknown>;
      const sectionTitle = compactVisibleText(section.title, 40);
      const sectionKey = normalizeVisibleKey(sectionTitle);
      if (!sectionTitle || !sectionKey || !Array.isArray(section.items)) continue;

      const existing = sectionByTitle.get(sectionKey);
      if (existing) {
        appendUniqueVisibleText(existing.items, section.items.slice(0, 12), 5);
        continue;
      }
      if (sections.length >= 4) continue;

      const items: string[] = [];
      appendUniqueVisibleText(items, section.items.slice(0, 12), 5);
      if (items.length === 0) continue;
      const parsedSection: AnalysisViewSection = {
        title: sectionTitle,
        items,
        ...(section.tone === undefined ? {} : { tone: parseTone(section.tone) }),
      };
      sections.push(parsedSection);
      sectionByTitle.set(sectionKey, parsedSection);
    }
  }

  if (metrics.length === 0 && sections.length === 0) return undefined;
  return {
    title,
    verdict,
    tone: parseTone(raw.tone, 'info'),
    metrics,
    sections,
  };
}
