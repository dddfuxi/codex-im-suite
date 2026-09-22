import type { PanelSettingsSnapshotContract } from '@codex-im-suite/contracts/panel-settings';

export type PanelSettingsIntent = 'list' | 'update' | null;

/**
 * 这里只识别“受控设置对象 + 读写意图”，不解析具体属性和值；属性解析始终交给
 * Primary，并由 Runtime 目录再次校验，避免固定句子或自然语言直写 env。
 */
export function resolvePanelSettingsIntent(text: string): PanelSettingsIntent {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  const hasSettingsObject = /(?:控制面板|面板|机器人|bridge|codex)[^。！？\n]{0,20}(?:设置|配置|属性|参数)|(?:设置|配置|属性|参数)[^。！？\n]{0,20}(?:控制面板|面板|机器人|bridge|codex)/iu.test(normalized);
  const hasKnownArea = /(?:回复风格|默认执行器|安全策略|工作目录|允许.*目录|记忆仓库|本地\s*AI|模型来源|路由模式|推理强度|记忆整理|Ollama)/iu.test(normalized);
  if (!hasSettingsObject && !hasKnownArea) return null;
  if (/(?:修改|改成|改为|设置为|设为|切换|调整|更新|开启|启用|关闭|禁用|换成)/iu.test(normalized)) return 'update';
  if (/(?:列出|查看|显示|读取|当前|现在|有哪些|是什么|信息|配置)/iu.test(normalized)) return 'list';
  return null;
}

function visibleValue(value: string | number | boolean, type: string): string {
  if (type === 'secret_status') return value === true ? '已配置' : '未配置';
  return JSON.stringify(value);
}

export function buildPanelSettingsEvidencePrompt(snapshot: PanelSettingsSnapshotContract): string {
  const lines = snapshot.settings.map((setting) => {
    const constraints = [
      setting.writable ? '可修改' : '只读',
      setting.restartRequired ? '需重启' : '即时生效',
      setting.enumValues?.length ? `枚举=${setting.enumValues.join('|')}` : '',
      setting.minimum !== undefined ? `最小=${setting.minimum}` : '',
      setting.maximum !== undefined ? `最大=${setting.maximum}` : '',
    ].filter(Boolean).join('；');
    return `- ${setting.label}（key=${setting.key}，${setting.type}，${constraints}）：${visibleValue(setting.value, setting.type)}`;
  });
  return [
    'Panel settings Host evidence (cti-panel-settings-evidence/v1):',
    `- snapshotVersion: ${snapshot.version}`,
    ...lines,
    '- 查询请求：只根据以上真实快照列出当前信息，不猜测、不显示 API key/token 明文。',
    '- 修改请求：输出且只输出一个 fenced ```cti-panel-settings JSON 动作块；action="update"，changes 为 1–10 个 {key,value}，expectedVersion 使用上述 snapshotVersion。',
    '- 只能使用上面标记“可修改”的稳定 key；不得提交 env 名、身份、命令、路径来源、token、API key 或重启参数。',
    '- 不要声称已保存或已生效；Bridge 会用真实 Host 回执生成最终结果并自动列出更新后的完整脱敏快照。',
  ].join('\n');
}

export function formatPanelSettingsSnapshot(snapshot: PanelSettingsSnapshotContract): string {
  const groups = new Map<string, string[]>();
  for (const setting of snapshot.settings) {
    const rows = groups.get(setting.group) || [];
    rows.push(`- ${setting.label}：${visibleValue(setting.value, setting.type)}`);
    groups.set(setting.group, rows);
  }
  return [...groups.entries()].map(([group, rows]) => `### ${group}\n${rows.join('\n')}`).join('\n\n');
}
