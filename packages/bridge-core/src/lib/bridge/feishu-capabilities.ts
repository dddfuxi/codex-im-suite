import type { SettingsProvider } from './host.js';

type ScopeRequirement = string | string[];

interface FeishuCapability {
  id: string;
  label: string;
  status: 'ready' | 'partial' | 'manual';
  requiredScopes: ScopeRequirement[];
  note: string;
}

const OAUTH_DEFAULT_SCOPES = [
  'offline_access',
  'auth:user.id:read',
  'docx:document:readonly',
  'sheets:spreadsheet:readonly',
  'sheets:spreadsheet:read',
  'drive:drive:readonly',
  'bitable:app:readonly',
  'base:table:read',
  'base:field:read',
  'base:record:retrieve',
];

const CAPABILITIES: FeishuCapability[] = [
  {
    id: 'im.inbound',
    label: 'WS 入站消息',
    status: 'ready',
    requiredScopes: ['im:message:receive_v1'],
    note: '订阅 im.message.receive_v1 事件后进入 bridge-core。',
  },
  {
    id: 'im.outbound',
    label: '文本 / Markdown / 卡片回复',
    status: 'ready',
    requiredScopes: [['im:message', 'im:message:send']],
    note: '使用 IM v1 发送消息和 reply；Markdown 默认渲染为飞书互动卡片。',
  },
  {
    id: 'im.resource',
    label: '图片 / 文件收发',
    status: 'ready',
    requiredScopes: [['im:resource', 'im:resource:upload']],
    note: '上传本地图片和文件，读取用户消息中的图片/文件资源。',
  },
  {
    id: 'im.history',
    label: '群历史读取和私聊补捞',
    status: 'ready',
    requiredScopes: ['im:message.group_msg'],
    note: '用于群聊历史同步、私聊漏事件补捞和被回复附件读取。',
  },
  {
    id: 'im.reactions',
    label: 'Typing 表情反应',
    status: 'ready',
    requiredScopes: ['im:message.reactions:write_only', 'im:message.reactions:read'],
    note: '任务开始时尝试添加 Typing reaction，结束后清理；缺权限时降级为无 reaction。',
  },
  {
    id: 'card.streaming',
    label: 'CardKit 流式卡片',
    status: 'partial',
    requiredScopes: ['cardkit:card:write', 'cardkit:card:read', 'im:message:update'],
    note: '默认开启；可用 CTI_FEISHU_STREAMING_CARD_ENABLED=false 关闭，失败会降级为普通最终回复。',
  },
  {
    id: 'card.action',
    label: '互动卡片按钮回调',
    status: 'ready',
    requiredScopes: [],
    note: '依赖 card.action.trigger 事件订阅；用于权限审批、提醒完成、扩展安装确认。',
  },
  {
    id: 'doc.create',
    label: '生成飞书 Docx 和大文件交付',
    status: 'ready',
    requiredScopes: [
      ['docx:document', 'docx:document:create'],
      'docx:document:readonly',
      'drive:drive',
    ],
    note: '创建 Docx、追加 block、上传 docx_file 附件并设置分享范围。',
  },
  {
    id: 'cloud.app_token',
    label: '应用 token 直读云文档',
    status: 'ready',
    requiredScopes: [
      'docx:document:readonly',
      'sheets:spreadsheet:readonly',
      'sheets:spreadsheet:read',
      'drive:drive:readonly',
      'bitable:app:readonly',
      'base:table:read',
      'base:field:read',
      'base:record:retrieve',
    ],
    note: '优先用 tenant_access_token 读取 Docx / Sheets / Base；仍受文档自身访问权限和应用已发布 scope 限制。',
  },
  {
    id: 'cloud.oauth_fallback',
    label: '用户 OAuth fallback',
    status: 'ready',
    requiredScopes: [
      'offline_access',
      'auth:user.id:read',
      'docx:document:readonly',
      'sheets:spreadsheet:readonly',
      'sheets:spreadsheet:read',
      'drive:drive:readonly',
      'bitable:app:readonly',
      'base:table:read',
      'base:field:read',
      'base:record:retrieve',
    ],
    note: '应用 token 无权读取时，让发起人登录后按本人 user_access_token 读取；不绕过文档权限。',
  },
  {
    id: 'cloud.docx',
    label: 'Docx raw_content 读取',
    status: 'ready',
    requiredScopes: ['docx:document:readonly'],
    note: 'Docx 走 raw_content 接口；应用 token 失败后再用发起人 OAuth token。',
  },
  {
    id: 'cloud.sheets',
    label: 'Sheets 有界范围读取',
    status: 'ready',
    requiredScopes: [['sheets:spreadsheet:readonly', 'sheets:spreadsheet:read', 'drive:drive:readonly']],
    note: '先查询 sheet，再读取有界范围；应用 token 失败后再用发起人 OAuth token。',
  },
  {
    id: 'cloud.base',
    label: 'Base / 多维表格读取',
    status: 'ready',
    requiredScopes: [
      'bitable:app:readonly',
      'base:table:read',
      'base:field:read',
      'base:record:retrieve',
    ],
    note: '读取 tables、fields、records，并按上限分页截断；应用 token 失败后再用发起人 OAuth token。',
  },
];

function splitScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s;|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readSetting(store: SettingsProvider, key: string, envKey?: string): string {
  return (store.getSetting(key) || (envKey ? process.env[envKey] : '') || '').trim();
}

function satisfiesRequirement(scopeSet: Set<string>, requirement: ScopeRequirement): boolean {
  if (Array.isArray(requirement)) return requirement.some((scope) => scopeSet.has(scope));
  return scopeSet.has(requirement);
}

function formatRequirement(requirement: ScopeRequirement): string {
  return Array.isArray(requirement) ? requirement.join(' 或 ') : requirement;
}

function missingRequirements(scopeSet: Set<string>, requirements: ScopeRequirement[]): string[] {
  return requirements
    .filter((requirement) => !satisfiesRequirement(scopeSet, requirement))
    .map(formatRequirement);
}

function formatBool(value: boolean): string {
  return value ? 'yes' : 'no';
}

export function getFeishuRecommendedScopes(): string[] {
  const all = new Set<string>();
  for (const capability of CAPABILITIES) {
    for (const requirement of capability.requiredScopes) {
      if (Array.isArray(requirement)) {
        for (const scope of requirement) all.add(scope);
      } else {
        all.add(requirement);
      }
    }
  }
  return Array.from(all).sort();
}

export function buildFeishuCapabilityReport(store: SettingsProvider): string {
  const appId = readSetting(store, 'bridge_feishu_app_id', 'CTI_FEISHU_APP_ID');
  const appSecret = readSetting(store, 'bridge_feishu_app_secret', 'CTI_FEISHU_APP_SECRET');
  const oauthMode = readSetting(store, 'bridge_feishu_oauth_mode', 'CTI_FEISHU_OAUTH_MODE') || 'callback';
  const oauthPublicBaseUrl = readSetting(store, 'bridge_feishu_oauth_public_base_url', 'CTI_FEISHU_OAUTH_PUBLIC_BASE_URL');
  const oauthManualRedirectUri = readSetting(store, 'bridge_feishu_oauth_manual_redirect_uri', 'CTI_FEISHU_OAUTH_MANUAL_REDIRECT_URI');
  const oauthCallbackPath = readSetting(store, 'bridge_feishu_oauth_callback_path', 'CTI_FEISHU_OAUTH_CALLBACK_PATH') || '/feishu/oauth/callback';
  const oauthScopes = splitScopes(
    readSetting(store, 'bridge_feishu_oauth_scopes', 'CTI_FEISHU_OAUTH_SCOPES')
    || OAUTH_DEFAULT_SCOPES.join(','),
  );
  const declaredScopes = splitScopes(readSetting(store, 'bridge_feishu_granted_scopes', 'CTI_FEISHU_GRANTED_SCOPES'));
  const declaredScopeSet = new Set(declaredScopes);
  const streamingCardRaw = readSetting(store, 'bridge_feishu_streaming_card_enabled', 'CTI_FEISHU_STREAMING_CARD_ENABLED');
  const streamingCardEnabled = streamingCardRaw
    ? ['1', 'true', 'yes', 'on'].includes(streamingCardRaw.toLowerCase())
    : true;

  const lines = [
    'Feishu Developer Platform Capabilities',
    '',
    'Runtime config:',
    `- app_id configured: ${formatBool(!!appId)}`,
    `- app_secret configured: ${formatBool(!!appSecret)}`,
    `- Cloud document app-token first read: ${appId && appSecret ? 'enabled' : 'disabled (missing app credentials)'}`,
    `- Cloud document user OAuth fallback: ${oauthMode === 'manual' || oauthPublicBaseUrl ? 'enabled' : 'disabled (missing CTI_FEISHU_OAUTH_PUBLIC_BASE_URL)'}`,
    `- OAuth mode: ${oauthMode}`,
    `- OAuth public callback: ${oauthPublicBaseUrl || '(not configured)'}`,
    `- OAuth manual redirect URI: ${oauthManualRedirectUri || (oauthMode === 'manual' ? '(default local callback)' : '(not configured)')}`,
    `- OAuth callback path: ${oauthCallbackPath}`,
    `- OAuth requested scopes: ${oauthScopes.join(', ') || '(none)'}`,
    `- Declared opened scopes (CTI_FEISHU_GRANTED_SCOPES): ${declaredScopes.join(', ') || '(not declared)'}`,
    `- Streaming card enabled: ${formatBool(streamingCardEnabled)}`,
    '',
    'Capability matrix:',
  ];

  for (const capability of CAPABILITIES) {
    const missing = declaredScopes.length > 0
      ? missingRequirements(declaredScopeSet, capability.requiredScopes)
      : [];
    const scopeText = capability.requiredScopes.length > 0
      ? capability.requiredScopes.map(formatRequirement).join(', ')
      : '(event subscription / no extra scope)';
    const state = declaredScopes.length === 0
      ? capability.status
      : missing.length === 0
        ? capability.status
        : 'manual';
    lines.push(`- [${state}] ${capability.label}`);
    lines.push(`  scopes: ${scopeText}`);
    if (missing.length > 0) lines.push(`  missing: ${missing.join(', ')}`);
    lines.push(`  note: ${capability.note}`);
  }

  const oauthMissing = missingRequirements(new Set(oauthScopes), [
    'offline_access',
    'auth:user.id:read',
    'docx:document:readonly',
    'sheets:spreadsheet:readonly',
    'sheets:spreadsheet:read',
    'drive:drive:readonly',
    'bitable:app:readonly',
    'base:table:read',
    'base:field:read',
    'base:record:retrieve',
  ]);
  if (oauthMissing.length > 0) {
    lines.push('', `Missing OAuth request scopes: ${oauthMissing.join(', ')}`);
  }

  if (declaredScopes.length > 0) {
    const allMissing = missingRequirements(declaredScopeSet, getFeishuRecommendedScopes());
    lines.push('', `Missing declared scopes: ${allMissing.join(', ') || '(none)'}`);
  } else {
    lines.push('', 'Missing declared scopes: unknown because CTI_FEISHU_GRANTED_SCOPES is not set.');
  }
  lines.push('Reminder: Feishu permission changes only take effect after the app version is published and tenant approval is completed.');
  return lines.join('\n');
}
