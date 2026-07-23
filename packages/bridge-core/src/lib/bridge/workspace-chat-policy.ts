import type { RegisteredProject } from '@codex-im-suite/contracts';

export type WorkspaceChatCommand =
  | { kind: 'list' }
  | { kind: 'switch'; target: string };

export interface WorkspaceChatCatalogEntry {
  index: number;
  project: RegisteredProject;
  current: boolean;
}

function normalizeChatText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 仅识别明确的工作区管理表达，避免普通项目讨论被确定性入口误拦截。
 */
export function parseWorkspaceChatCommand(rawText: string): WorkspaceChatCommand | null {
  const text = normalizeChatText(rawText).replace(/[。！？!?]+$/gu, '').trim();
  if (!text) return null;

  if (
    /^(?:(?:请|麻烦)(?:帮我)?|帮我)?(?:列出|查看|显示|查询|看看)(?:一下)?(?:当前)?(?:可用|已注册)?(?:的)?工作区(?:列表)?$/u.test(text)
    || /^(?:当前)?(?:有哪些|有什么)(?:可用|已注册)?(?:的)?工作区$/u.test(text)
    || /^(?:(?:我想|我要|我需要|请|麻烦)?(?:帮我)?)?(?:(?:选择|切换|更换|管理|查看)(?:一下)?)?工作区(?:列表|切换)?$/u.test(text)
    || /^(?:(?:我想|我要|我需要|请|麻烦)?(?:帮我)?)?(?:选择|切换|更换|管理)(?:一下)?(?:当前)?工作(?:目录|路径)$/u.test(text)
  ) {
    return { kind: 'list' };
  }

  const switchPatterns = [
    /^(?:(?:请|麻烦)(?:帮我)?|帮我)?(?:把)?(?:当前(?:会话)?(?:的)?)?工作(?:区|目录|路径)(?:切换|切|改|绑定)(?:到|为|成)\s*(.+)$/u,
    /^(?:(?:请|麻烦)(?:帮我)?|帮我)?(?:切换|切|进入|使用)\s*(?:到\s*)?工作(?:区|目录|路径)(?:\s*(?:到|为|成))?\s*(.+)$/u,
  ];
  for (const pattern of switchPatterns) {
    const match = text.match(pattern);
    const target = match?.[1]?.trim().replace(/^["'“”‘’]|["'“”‘’]$/gu, '').trim();
    if (target) return { kind: 'switch', target };
  }

  return null;
}

function comparePath(value: string): string {
  return value.replace(/[\\/]+$/gu, '').toLowerCase();
}

export function buildWorkspaceChatCatalog(
  projects: readonly RegisteredProject[],
  currentWorkingDirectory?: string,
): WorkspaceChatCatalogEntry[] {
  const currentPath = currentWorkingDirectory ? comparePath(currentWorkingDirectory) : '';
  return projects
    .filter((project) => project.enabled)
    .slice()
    .sort((left, right) => (
      left.displayName.localeCompare(right.displayName, 'zh-CN')
      || left.id.localeCompare(right.id)
    ))
    .map((project, index) => ({
      index: index + 1,
      project,
      current: Boolean(currentPath) && comparePath(project.workspaceRoot) === currentPath,
    }));
}

export type WorkspaceTargetResolution =
  | { kind: 'resolved'; entry: WorkspaceChatCatalogEntry }
  | { kind: 'ambiguous'; entries: WorkspaceChatCatalogEntry[] }
  | { kind: 'not_found' };

/**
 * 项目 ID、完整名称、编号和注册路径都可解析；模糊名称只有唯一命中时才生效。
 */
export function resolveWorkspaceChatTarget(
  catalog: readonly WorkspaceChatCatalogEntry[],
  rawTarget: string,
): WorkspaceTargetResolution {
  const target = normalizeChatText(rawTarget);
  if (!target) return { kind: 'not_found' };

  if (/^[1-9]\d*$/u.test(target)) {
    const entry = catalog.find((item) => item.index === Number(target));
    return entry ? { kind: 'resolved', entry } : { kind: 'not_found' };
  }

  const normalizedTarget = target.toLowerCase();
  const exact = catalog.filter(({ project }) => (
    project.id.toLowerCase() === normalizedTarget
    || project.displayName.toLowerCase() === normalizedTarget
    || comparePath(project.workspaceRoot) === comparePath(target)
  ));
  if (exact.length === 1) return { kind: 'resolved', entry: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', entries: exact };

  const partial = catalog.filter(({ project }) => (
    project.id.toLowerCase().includes(normalizedTarget)
    || project.displayName.toLowerCase().includes(normalizedTarget)
  ));
  if (partial.length === 1) return { kind: 'resolved', entry: partial[0] };
  if (partial.length > 1) return { kind: 'ambiguous', entries: partial };
  return { kind: 'not_found' };
}
