import type { FeishuCloudLinkResolveResult } from '../../../host.js';

export type FeishuCloudResolutionDecision =
  | { kind: 'resolved'; systemPrompt: string }
  | { kind: 'blocked'; text: string; feishuCardJson: string | undefined }
  | { kind: 'no_links' };

export interface FeishuOAuthAuditMessage {
  channelType: string;
  chatId: string;
  messageId: string;
  userId?: string;
}

export interface FeishuOAuthRequestAuditInput {
  channelType: string;
  chatId: string;
  direction: 'outbound';
  messageId: string;
  summary: string;
}

const FEISHU_CLOUD_RESOURCE_SEGMENTS = new Set(['docx', 'docs', 'sheets', 'base', 'bitable']);
const URL_CANDIDATE_RE = /https?:\/\/[^\s<>"')\]]+/giu;

function isFeishuCloudHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return normalized === 'feishu.cn'
    || normalized.endsWith('.feishu.cn')
    || normalized === 'larksuite.com'
    || normalized.endsWith('.larksuite.com');
}

function isSupportedFeishuCloudUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol) || !isFeishuCloudHostname(url.hostname)) return false;
    const resourceType = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
    return FEISHU_CLOUD_RESOURCE_SEGMENTS.has(resourceType);
  } catch {
    return false;
  }
}

export function isFeishuDocumentGenerationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  const mentionsDoc = /(?:飞书文档|文档链接|回链接|发链接|在线文档)/u.test(normalized);
  const asksToGenerate = /(?:生成|整理成|做成|输出成|输出到|保存成|创建)/u.test(normalized);
  return mentionsDoc && asksToGenerate;
}

export function isFeishuDocumentGenerationRequestStrict(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  const mentionsDoc = /(?:飞书文档|云文档|文档链接|在线文档|docx|document)/iu.test(normalized);
  const asksToGenerate = /(?:生成|整理成|做成|输出到|保存|创建|重写|更新|修改|生成.*链接|回链接)/u.test(normalized);
  return mentionsDoc && asksToGenerate;
}

export function isFeishuDocumentListRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return /(?:有哪些文档|文档有哪些|文档列表|生成过什么文档|之前.*文档|导览文档|文档导览|list.*docs|docs.*list)/iu.test(normalized);
}

export function buildFeishuDocumentMemoryAgentPrompt(renderedList: string, userText: string): string {
  const request = userText.trim();
  const list = renderedList.trim() || '没有找到已记录的飞书文档。';
  return [
    '飞书文档索引检索结果（作为 agent 上下文，不是最终回复）：',
    request ? `- 用户请求：${request}` : '',
    '- 来源：本地 bridge 记录的飞书文档索引。',
    '',
    list,
    '',
    '回复要求：',
    '- 由 agent 根据用户当前问题整理最终回复，不要把索引文本原样作为快捷回复。',
    '- 如果用户只问文档列表，给出简洁可读的列表；如果用户问某类文档，只筛选相关项。',
    '- 保留索引里的标题、链接、时间等原始事实；不要编造索引中不存在的文档、链接、作者或状态。',
    '- 如果索引为空或证据不足，明确说明没有找到可靠记录。',
  ].filter(Boolean).join('\n');
}

export function buildFeishuDocumentDraftTitle(
  now: Date,
  timeZone = 'Asia/Shanghai',
): string {
  const timeLabel = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(now).replace(/[/:]/g, '-');
  return `Document Draft ${timeLabel}`;
}

export function isGenericFeishuDocumentTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return /^(?:群聊总结|最近消息|会话整理|聊天记录|原始记录|document draft)/iu.test(normalized)
    || /^(?:group chat summary|recent messages|conversation cleanup)/iu.test(normalized);
}

export function buildFeishuDocumentRewritePrompt(sourceMarkdown: string, userRequest: string): string {
  return [
    '请把下面的材料整理成一份适合直接写入飞书文档的 Markdown 正文。',
    '',
    '硬性要求：',
    '1. 第一行必须是有内容含义的一级标题，不要写“聊天记录”“原始记录”“以下是”“群聊总结”“最近消息”等流水账标题，也不要用时间戳当标题。',
    '2. 文档默认使用这些结构：结论摘要、关键事实、执行结果、问题与风险、后续待办。',
    '3. 如果材料来自群聊或执行日志，要提炼结论，不要按时间顺序逐条复述聊天记录。',
    '4. 如果材料里包含失败/空白截图/替代方案，必须在“问题与风险”里明确写出来，不要包装成成功。',
    '5. 如果是 Unity 场景类文档，需要附录时优先附“场景位置”，不要附截图文件路径清单，除非用户明确要求截图路径。',
    '6. 只输出文档正文，不要输出说明、客套话、代码块围栏或“已生成文档”。',
    '',
    `用户当前请求：${userRequest}`,
    '',
    '=== 待整理材料开始 ===',
    sourceMarkdown.trim(),
    '=== 待整理材料结束 ===',
  ].join('\n');
}

export function containsFeishuCloudDocumentLink(text: string): boolean {
  return Array.from(text.matchAll(URL_CANDIDATE_RE)).some((match) => isSupportedFeishuCloudUrl(match[0]));
}

export function shouldResolveFeishuCloudLinks(channelType: string, text: string): boolean {
  return channelType === 'feishu' && containsFeishuCloudDocumentLink(text);
}

export function shouldHandleFeishuOAuthCallback(channelType: string, text: string): boolean {
  if (channelType !== 'feishu') return false;
  return /\bcode=[^&\s]+(?:&|&amp;)state=[^&\s]+|\bstate=[^&\s]+(?:&|&amp;)code=[^&\s]+/iu.test(text);
}

export function buildFeishuCloudBlockerMessage(result: FeishuCloudLinkResolveResult): string {
  const fallback = result.status === 'auth_required'
    ? '需要你登录飞书后，我才能安全读取这个云文档。'
    : result.status === 'permission_denied'
      ? '未完成：当前登录飞书用户也没有这个云文档权限，请让文档所有者分享给你或导出内容。'
      : '未完成：读取飞书云文档失败。';
  return result.userMessage?.trim() || result.error?.trim() || fallback;
}

export function resolveFeishuOAuthCardJson(result: FeishuCloudLinkResolveResult): string | undefined {
  // reuse 表示同一用户和规范化 scope 已有授权请求，治理层不得重复发卡。
  return result.authorizationCardDisposition === 'reuse' ? undefined : result.feishuCardJson;
}

export function decideFeishuCloudResolution(
  result: FeishuCloudLinkResolveResult,
): FeishuCloudResolutionDecision {
  if (result.status === 'no_links') return { kind: 'no_links' };
  if (result.status === 'resolved') {
    const systemPrompt = result.systemPrompt?.trim() || '';
    return systemPrompt
      ? { kind: 'resolved', systemPrompt }
      : {
        kind: 'blocked',
        text: '未完成：飞书云文档读取结果缺少可靠正文，无法继续处理。',
        feishuCardJson: undefined,
      };
  }
  return {
    kind: 'blocked',
    text: buildFeishuCloudBlockerMessage(result),
    feishuCardJson: resolveFeishuOAuthCardJson(result),
  };
}

export function buildFeishuOAuthRequestAuditInput(
  message: FeishuOAuthAuditMessage,
  result: FeishuCloudLinkResolveResult,
): FeishuOAuthRequestAuditInput | undefined {
  if (result.status !== 'auth_required' || !result.authorizationRequestId) return undefined;
  const disposition = result.authorizationCardDisposition || 'send';
  const scopes = (result.requestedScopes || []).join(',') || '(unspecified)';
  return {
    channelType: message.channelType,
    chatId: message.chatId,
    direction: 'outbound',
    messageId: message.messageId,
    summary: `[FEISHU_OAUTH_REQUEST] requestId=${result.authorizationRequestId} disposition=${disposition} userId=${message.userId || '(unknown)'} scopes=${scopes}`,
  };
}

export function sanitizeFeishuCloudDocumentLinks(text: string): string {
  return text.replace(URL_CANDIDATE_RE, (candidate) => (
    isSupportedFeishuCloudUrl(candidate) ? '[已读取的飞书云文档]' : candidate
  )).trim();
}
