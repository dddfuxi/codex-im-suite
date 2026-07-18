export const panelPageMeta = {
  overview: { label: '总览' },
  services: { label: '服务' },
  sessions: { label: '会话' },
  scheduledTasks: { label: '计划任务' },
  architecture: { label: '机器人架构' },
  prompts: { label: '提示词注入' },
  memory: { label: '记忆索引' },
  skills: { label: 'Skills' },
  mcp: { label: 'MCP' },
  modelsPlugins: { label: '模型与插件' },
  permissions: { label: '权限' },
  release: { label: '发布' },
  logs: { label: '日志' },
  settings: { label: '设置' },
} as const;

export type PageId = keyof typeof panelPageMeta;
export type ServiceTabId = 'services' | 'nodes' | 'executors';

export const panelNavigation = [
  { id: 'run', label: '运行', pages: ['overview', 'services', 'sessions', 'scheduledTasks'] },
  { id: 'robot', label: '机器人', pages: ['architecture', 'prompts', 'memory'] },
  { id: 'capability', label: '能力', pages: ['skills', 'mcp', 'modelsPlugins'] },
  { id: 'governance', label: '治理', pages: ['permissions', 'release', 'logs', 'settings'] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  pages: readonly PageId[];
}>;

const pageIds = new Set<PageId>(Object.keys(panelPageMeta) as PageId[]);
const legacyPageMap: Record<string, PageId> = {
  extensions: 'skills',
  nodes: 'services',
  executors: 'services',
};

function normalizeRouteId(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^#\/?/u, '');
}

export function resolvePageId(value: string | null | undefined): PageId {
  const normalized = normalizeRouteId(value);
  if (normalized in legacyPageMap) return legacyPageMap[normalized];
  return pageIds.has(normalized as PageId) ? normalized as PageId : 'overview';
}

export function resolveLegacyServiceTab(value: string | null | undefined): ServiceTabId {
  const normalized = normalizeRouteId(value);
  return normalized === 'nodes' || normalized === 'executors' ? normalized : 'services';
}
