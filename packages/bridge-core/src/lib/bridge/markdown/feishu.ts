import type { OutboundMention, RunSummary, ToolCallInfo } from '../types.js';

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text), then only
  // normalize presentation syntax outside fenced code so examples stay exact.
  const withFenceSpacing = text.replace(/\r\n/g, '\n').replace(/([^\n])```/g, '$1\n```');
  return withFenceSpacing
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      // Card 2.0 Markdown does not document underline support. Preserve the
      // intended emphasis with a supported accent instead of leaking raw HTML.
      const supportedEmphasis = segment.replace(/<(u|ins)\b[^>]*>([\s\S]*?)<\/\1>/giu, (_match, _tag, content: string) => (
        `<font color='blue'>**${content.trim()}**</font>`
      ));
      // Card Markdown 对“加粗标签闭合后立刻接正文”的解析不稳定；只规范化
      // 以中英文冒号结尾的标签，不改普通句内加粗，也不触碰代码示例。
      return supportedEmphasis.replace(/(\*\*[^*\r\n]{1,64}[：:]\*\*)(?=[\p{L}\p{N}“‘"'（(\[])/gu, '$1 ');
    })
    .join('');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string, mentions: OutboundMention[] = []): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: renderFeishuMarkdownMentions(text, mentions),
        },
      ],
    },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string, mentions: OutboundMention[] = []): string {
  const content = mentions.length > 0
    ? [buildPostElementsWithMentions(text, mentions)]
    : [[{ tag: 'md', text }]];
  return JSON.stringify({
    zh_cn: {
      content,
    },
  });
}

interface NormalizedMention {
  userId: string;
  name: string;
  atAll: boolean;
}

function normalizeMentions(mentions: OutboundMention[]): NormalizedMention[] {
  const normalized: NormalizedMention[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    const atAll = mention.atAll === true;
    const userId = atAll ? 'all' : (mention.userId || '').trim();
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    normalized.push({
      userId,
      name: (mention.name || (atAll ? '所有人' : '用户')).trim() || (atAll ? '所有人' : '用户'),
      atAll,
    });
  }
  return normalized;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mentionTextPattern(mention: NormalizedMention): RegExp {
  if (mention.atAll) return /@(?:all|所有人)(?=$|[\s,，.。!！?？~～:：;；])/iu;
  return new RegExp(`@${escapeRegExp(mention.name)}(?=$|[\\s,，.。!！?？~～:：;；])`, 'u');
}

function renderMarkdownAt(mention: NormalizedMention): string {
  return `<at id="${escapeAttr(mention.userId)}"></at>`;
}

function renderPostAt(mention: NormalizedMention): Record<string, string> {
  return {
    tag: 'at',
    user_id: mention.userId,
    user_name: mention.name,
  };
}

function mentionKey(mention: NormalizedMention): string {
  return mention.atAll ? '__all__' : mention.userId;
}

interface PostMentionMatch {
  mention: NormalizedMention;
  index: number;
  length: number;
}

export function renderFeishuMarkdownMentions(text: string, mentions: OutboundMention[] = []): string {
  const normalizedMentions = normalizeMentions(mentions);
  if (normalizedMentions.length === 0) return text;
  if (/<at\s+(?:id|user_id)=/iu.test(text)) return text;

  let rendered = text;
  const missing: NormalizedMention[] = [];
  for (const mention of normalizedMentions) {
    const pattern = mentionTextPattern(mention);
    if (pattern.test(rendered)) {
      rendered = rendered.replace(pattern, renderMarkdownAt(mention));
    } else {
      missing.push(mention);
    }
  }

  if (missing.length === 0) return rendered;
  const prefix = missing.map(renderMarkdownAt).join(' ');
  return rendered.trim() ? `${prefix} ${rendered}` : prefix;
}

function buildPostElementsWithMentions(text: string, mentions: OutboundMention[]): Array<Record<string, string>> {
  const normalizedMentions = normalizeMentions(mentions);
  const elements: Array<Record<string, string>> = [];
  let remaining = text;
  const found = new Set<string>();

  while (remaining) {
    let next: PostMentionMatch | null = null;
    for (const mention of normalizedMentions) {
      const match = mentionTextPattern(mention).exec(remaining);
      if (!match || match.index < 0) continue;
      if (
        !next
        || match.index < next.index
        || (match.index === next.index && match[0].length > next.length)
      ) {
        next = { mention, index: match.index, length: match[0].length };
      }
    }
    if (!next) break;
    const before = remaining.slice(0, next.index);
    if (before) elements.push({ tag: 'text', text: before });
    elements.push(renderPostAt(next.mention));
    found.add(mentionKey(next.mention));
    remaining = remaining.slice(next.index + next.length);
  }

  if (remaining) elements.push({ tag: 'text', text: remaining });
  const missing = normalizedMentions.filter((mention) => !found.has(mentionKey(mention)));
  const prefix = missing.map(renderPostAt);
  const combined = [...prefix, ...elements];
  return combined.length > 0 ? combined : [{ tag: 'text', text }];
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build user-visible tool progress markdown lines.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const observedStarts = tools
    .map((tool) => tool.startedAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const baseline = observedStarts.length > 0 ? Math.min(...observedStarts) : undefined;
  const lines = tools.map((tc, index) => {
    const status = formatToolStatus(tc.status);
    const timeline = formatToolTimelineMark(tc, index, baseline);
    const duration = formatToolDuration(tc);
    return `${timeline} · ${status} · ${formatVisibleToolCall(tc)}${duration}`;
  });
  return lines.join('\n');
}

function formatToolTimelineMark(tool: ToolCallInfo, index: number, baseline?: number): string {
  if (typeof baseline === 'number' && typeof tool.startedAt === 'number') {
    return `<font color="grey">+${formatCompactDuration(Math.max(0, tool.startedAt - baseline))}</font>`;
  }
  return `<font color="grey">${String(index + 1).padStart(2, '0')}</font>`;
}

function formatToolDuration(tool: ToolCallInfo): string {
  if (typeof tool.startedAt !== 'number' || typeof tool.completedAt !== 'number') return '';
  return ` <font color="grey">(${formatCompactDuration(Math.max(0, tool.completedAt - tool.startedAt))})</font>`;
}

function formatCompactDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${String(sec).padStart(2, '0')}s`;
}

function formatToolStatus(status: ToolCallInfo['status']): string {
  if (status === 'running') return '<font color="blue">进行中</font>';
  if (status === 'complete') return '<font color="green">已完成</font>';
  return '<font color="red">失败</font>';
}

export function formatVisibleToolName(name: string): string {
  const normalized = (name || '').trim();
  const lower = normalized.toLowerCase();
  if (!normalized) return '工具执行';
  if (lower === 'bash' || lower === 'shell' || lower === 'powershell') return '本地命令';
  if (lower.includes('shell_artifact')) return '桌面截图';
  if (lower.includes('manage_camera')) return 'Unity MCP 截图';
  if (lower.includes('manage_scene')) return 'Unity MCP 场景操作';
  if (lower.includes('find_gameobjects') || lower.includes('manage_gameobject')) return 'Unity MCP 节点查询';
  if (lower.includes('read_file')) return '文件读取';
  if (lower.includes('list_dir')) return '目录读取';
  if (lower.includes('search_files')) return '文件搜索';
  if (lower.includes('mcp_call') || lower.includes('unity_mcp')) return 'MCP 工具执行';
  if (lower.includes('shell')) return '本地命令';
  return normalized.replace(/^JsonTool:/i, '');
}

function formatVisibleToolCall(tool: ToolCallInfo): string {
  const name = (tool.name || '').trim();
  const lower = name.toLowerCase();
  if (lower === 'bash' || lower === 'shell' || lower === 'powershell') {
    return summarizeShellToolInput(tool.input) || '执行本地命令';
  }
  return formatVisibleToolName(name);
}

function summarizeShellToolInput(input: unknown): string | null {
  const command = readStringField(input, 'command');
  if (!command) return null;
  return summarizeShellCommand(command);
}

function readStringField(input: unknown, key: string): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function summarizeShellCommand(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  if (!lower) return '执行本地命令';

  // Show intent, not the raw command. This keeps final cards useful without leaking local paths.
  if (/sync-live-skill\.ps1/u.test(lower)) return '同步 live skill';
  if (/daemon\.ps1/u.test(lower) && /\brestart\b/u.test(lower)) return '重启 bridge 服务';
  if (/daemon\.ps1/u.test(lower) && /\bstatus\b/u.test(lower)) return '检查 bridge 状态';
  if (/doctor-suite-targets\.ps1/u.test(lower)) return '检查 suite/live 目标';
  if (/update-architecture-docs\.ps1/u.test(lower)) return '检查架构文档';
  if (/status\.json|bridge-runtime-audit\.json/u.test(lower)) return '读取状态文件';
  if (/bridge\.log|\.log\b/u.test(lower)) return '查看日志';
  if (/\bgit\s+status\b/u.test(lower)) return '检查 Git 状态';
  if (/\bgit\s+diff\b/u.test(lower)) return '查看代码变更';
  if (/\bgit\s+(?:show|log)\b/u.test(lower)) return '查看 Git 记录';
  if (/\bnpm\b[\s\S]{0,120}\brun\b[\s\S]{0,120}\btest|(?:^|[\s;&|])node\s+--test\b|\bdotnet\s+test\b|\bpnpm\b[\s\S]{0,120}\btest\b|\byarn\b[\s\S]{0,120}\btest\b/u.test(lower)) {
    return '运行测试';
  }
  if (/\bnpm\b[\s\S]{0,120}\brun\b[\s\S]{0,120}\bbuild|\bpnpm\b[\s\S]{0,120}\bbuild\b|\byarn\b[\s\S]{0,120}\bbuild\b|\btsc\b|\bvite\s+build\b|\bdotnet\s+(?:build|publish)\b/u.test(lower)) {
    return '构建项目';
  }
  if (/\brg\b|\bgrep\b|\bfindstr\b|\bselect-string\b/u.test(lower)) return '搜索文件';
  if (/\bget-content\b|\bcat\b|\btype\b|\btail\b|\bhead\b|\bsed\b/u.test(lower)) return '读取文件';
  if (/\bget-childitem\b|(?:^|[\s;&|])ls(?:\s|$)|(?:^|[\s;&|])dir(?:\s|$)/u.test(lower)) return '查看目录';
  if (/\bremove-item\b|\bdel\b|\brm\b/u.test(lower)) return '清理文件';
  if (/\bcopy-item\b|\bcopy\b|\bcp\b/u.test(lower)) return '复制文件';
  if (/\bmove-item\b|\bmove\b|\bmv\b/u.test(lower)) return '移动文件';
  return '执行本地命令';
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

function extractStreamingStepLines(text: string): string[] {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*[-•]\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => !/^(?:#{1,6}\s*)?(?:处理进度|处理思路|执行细节|工具阶段结果)\s*[:：]?\s*$/u.test(line))
    .filter((line) => !/^[-_]{3,}$/.test(line));
}

function escapeFeishuInlineMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inferStreamingStepTitle(step: string, tools: ToolCallInfo[]): string {
  const text = `${step} ${tools.map((tool) => tool.name).join(' ')}`.toLowerCase();
  if (/证据|依据|截图|文件|目录|搜索|查找|读取|capture|read_file|list_dir|search_files/u.test(text)) return '确认证据';
  if (/工具|执行|命令|mcp|unity|shell|tool/u.test(text)) return '调用工具';
  if (/记忆|上下文|历史|会话|memory|context/u.test(text)) return '整理上下文';
  if (/整理|回复|收口|结果|final|answer/u.test(text)) return '整理回复';
  return '理解请求';
}

type StreamingTaskStage = 'understanding' | 'evidence' | 'tools' | 'result';

function inferStreamingTaskStage(title: string, tools: ToolCallInfo[]): StreamingTaskStage {
  if (title === '整理回复') return 'result';
  if (tools.some((tool) => tool.status === 'running')) return 'tools';
  if (tools.length > 0 && tools.every((tool) => tool.status !== 'running')) return 'result';
  if (title === '调用工具') return 'tools';
  if (title === '确认证据' || title === '整理上下文') return 'evidence';
  return 'understanding';
}

function formatStreamingStageRail(title: string, tools: ToolCallInfo[]): string {
  const stageOrder: Array<{ id: StreamingTaskStage; label: string }> = [
    { id: 'understanding', label: '理解' },
    { id: 'evidence', label: '证据' },
    { id: 'tools', label: '执行' },
    { id: 'result', label: '结果' },
  ];
  const activeIndex = stageOrder.findIndex((stage) => stage.id === inferStreamingTaskStage(title, tools));
  return stageOrder.map((stage, index) => {
    if (index < activeIndex) return `<font color="green">✓ ${stage.label}</font>`;
    if (index === activeIndex) return `<font color="purple">● ${stage.label}</font>`;
    return `<font color="grey">○ ${stage.label}</font>`;
  }).join('　');
}

function buildLiveToolTrace(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const completed = tools.filter((tool) => tool.status === 'complete').length;
  const failed = tools.filter((tool) => tool.status === 'error').length;
  const recent = tools.slice(-3).map((tool) => {
    const marker = tool.status === 'complete'
      ? '<font color="green">✓</font>'
      : tool.status === 'error'
        ? '<font color="red">×</font>'
        : '<font color="blue">◐</font>';
    return `${marker} ${formatVisibleToolCall(tool)}`;
  });
  const suffix = failed > 0 ? ` · 失败 ${failed}` : '';
  return [
    `<font color="grey">**执行轨迹 ${completed}/${tools.length}${suffix}**</font>`,
    ...recent,
  ].join('\n');
}

export function buildStreamingStepContent(step: string, tools: ToolCallInfo[] = []): string {
  const currentStep = step.trim() || '正在根据这条消息判断下一步。';
  const title = inferStreamingStepTitle(currentStep, tools);
  return buildStreamingStepContentWithTitle(title, currentStep, tools);
}

function buildStreamingStepContentWithTitle(title: string, step: string, tools: ToolCallInfo[]): string {
  const blocks = [
    `<font color="purple">**${title}**</font>`,
    `<font color="grey">${escapeFeishuInlineMarkdown(step)}</font>`,
    '',
    formatStreamingStageRail(title, tools),
  ];
  const liveToolTrace = buildLiveToolTrace(tools);
  if (liveToolTrace) blocks.push('', liveToolTrace);
  return blocks.join('\n');
}

export function getStreamingCurrentStep(text: string, tools: ToolCallInfo[]): string {
  const steps = extractStreamingStepLines(text);
  const activeTool = tools.find((tool) => tool.status === 'running') || tools[tools.length - 1];
  return steps[steps.length - 1]
    || (activeTool ? `正在根据 ${formatVisibleToolName(activeTool.name)} 的状态推进。` : '正在根据这条消息判断下一步。');
}

export function buildStreamingTypewriterContent(text: string, tools: ToolCallInfo[], visibleChars: number): string {
  const currentStep = getStreamingCurrentStep(text, tools);
  const visibleStep = [...currentStep].slice(0, Math.max(0, visibleChars)).join('');
  return buildStreamingStepContentWithTitle(inferStreamingStepTitle(currentStep, tools), visibleStep, tools);
}

/**
 * Build the body elements array for a streaming card update.
 * Shows one current user-visible planning step, refreshed as new progress arrives.
 */
export function buildStreamingContent(text: string, tools: ToolCallInfo[]): string {
  return buildStreamingStepContent(getStreamingCurrentStep(text, tools), tools);
}

/**
 * Streaming cards show progress while the task is running. Once the same card
 * is finalized, keep only the user-facing result section if the model provided
 * a separate rationale + result structure.
 */
export function extractStreamingFinalResponse(text: string): string {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (hasVisibleRationaleSections(normalized)) return normalized;

  const resultHeading = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:执行结果|最终结果)(?:\*\*)?\s*[:：]?[ \t]*(?:\n)?/u;
  const match = resultHeading.exec(normalized);
  if (!match) {
    return normalized.replace(/^\s*(?:#{1,6}\s*)?(?:\*\*)?最终结果(?:\*\*)?\s*[:：]?\s*/u, '').trim() || normalized;
  }

  const resultText = normalized.slice(match.index + match[0].length).trim();
  return resultText || normalized;
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string } | null,
  summary?: RunSummary,
  mentions: OutboundMention[] = [],
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Main result content stays result-first; detailed rationale is folded below.
  let content = stripStandaloneCompletionMarkLines(preprocessFeishuMarkdown(extractStreamingFinalResponse(text)));
  if (!content.trim()) {
    content = '未完成：模型没有返回可展示结果。';
  }
  const effectiveStatus = inferVisibleFinalCardStatus(footer?.status || '', content);
  const splitContent = splitFinalCardContentForDisplay(content);
  const titledContent = extractFinalCardTitleAndBody(splitContent.result || content);

  elements.push({
    tag: 'markdown',
    content: renderFeishuMarkdownMentions(titledContent.body, mentions),
    text_align: 'left',
    text_size: 'normal',
  });

  elements.push({
    tag: 'markdown',
    content: buildFinalEvidenceSummary(effectiveStatus, tools),
    text_align: 'left',
    text_size: 'notation',
  });

  const executionDetailBlocks: string[] = [];
  if (splitContent.detail) {
    executionDetailBlocks.push(renderFeishuMarkdownMentions(splitContent.detail, mentions));
  }
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    executionDetailBlocks.push(`<font color="grey">**工具轨迹**</font>\n${toolMd}`);
  }

  const executionDetailPanel = buildExecutionDetailPanel(executionDetailBlocks);
  if (executionDetailPanel) {
    elements.push(executionDetailPanel);
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    parts.push(formatCompletionMark(effectiveStatus));
    if (footer.elapsed) parts.push(`耗时：${footer.elapsed}`);
    parts.push(...formatRunSummaryFooterParts(summary));
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: `<font color="grey">${parts.join(' · ')}</font>`,
        text_size: 'notation',
      });
    }
  }

  const header = buildFinalCardHeader(effectiveStatus, titledContent.title);

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header,
    body: { elements },
  });
}

function inferVisibleFinalCardStatus(status: string, content: string): string {
  if (/失败|未完成|中断|error|interrupted/iu.test(status || '')) return status;
  const visible = stripStandaloneCompletionMarkLines(content)
    .replace(/^\s*(?:#{1,6}\s*)?(?:\*\*)?/u, '')
    .trim();
  return /^(?:未完成|失败|执行失败|阻塞|已拦截|无法完成)(?:\s*[:：]|\s|$)/iu.test(visible)
    ? '未完成'
    : status;
}

interface FinalCardContentSplit {
  result: string;
  detail: string;
}

const FINAL_RESULT_SECTION_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:执行结果|最终结果)(?:\*\*)?\s*[:：]?[ \t]*(?:\n|$)/gu;
const FINAL_DETAIL_HEADING_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:处理思路|处理依据|执行过程|执行细节|工具计划|工具阶段结果|依据)(?:\*\*)?\s*[:：]?/u;

function splitFinalCardContentForDisplay(content: string): FinalCardContentSplit {
  const normalized = stripStandaloneCompletionMarkLines((content || '').replace(/\r\n/g, '\n')).trim();
  if (!normalized) return { result: '', detail: '' };

  FINAL_RESULT_SECTION_RE.lastIndex = 0;
  for (const match of normalized.matchAll(FINAL_RESULT_SECTION_RE)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const before = normalized.slice(0, index).trim();
    const after = normalized.slice(index + match[0].length).trim();
    if (!before || !after) continue;
    if (!FINAL_DETAIL_HEADING_RE.test(before)) continue;
    if (!hasSubstantiveFinalBody(after)) continue;
    return {
      result: stripStandaloneCompletionMarkLines(after).trim(),
      detail: before,
    };
  }

  return { result: normalized, detail: '' };
}

function buildExecutionDetailPanel(blocks: string[]): Record<string, unknown> | null {
  const content = blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!content) return null;

  // Feishu Card JSON 2.0 supports collapsible_panel; keep evidence/process
  // details collapsed by default so the final answer remains result-first.
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: '执行轨迹' },
      template: 'default',
      padding: '8px 12px 8px 12px',
    },
    elements: [{
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'notation',
    }],
  };
}

function buildFinalEvidenceSummary(status: string, tools: ToolCallInfo[]): string {
  const failedResult = /失败|未完成|中断|error|interrupted/iu.test(status || '');
  const resultBadge = failedResult
    ? '<font color="red">● 结果未完成</font>'
    : '<font color="green">● 结果已生成</font>';
  if (tools.length === 0) {
    return `${resultBadge}　<font color="grey">● 仅文本回复</font>`;
  }

  const completed = tools.filter((tool) => tool.status === 'complete').length;
  const failed = tools.filter((tool) => tool.status === 'error').length;
  const running = tools.filter((tool) => tool.status === 'running').length;
  if (failed > 0) {
    return `${resultBadge}　<font color="red">● 工具失败 ${failed}/${tools.length}</font>`;
  }
  if (running > 0) {
    return `${resultBadge}　<font color="blue">● 工具进行中 ${running}/${tools.length}</font>`;
  }
  return `${resultBadge}　<font color="green">● 工具证据 ${completed}/${tools.length}</font>`;
}

function formatRunSummaryFooterParts(summary?: RunSummary): string[] {
  if (!summary) return [];
  const parts: string[] = [];
  const sourceLabel = formatExecutionSourceLabel(summary);
  if (sourceLabel) parts.push(`来源：${escapeFeishuInlineMarkdown(sourceLabel)}`);
  const modelLabel = formatModelLabel(summary);
  if (modelLabel) parts.push(`模型：${escapeFeishuInlineMarkdown(modelLabel)}`);

  const usage = summary.tokenUsage;
  if (usage) {
    const input = formatTokenCount(usage.input_tokens);
    const output = formatTokenCount(usage.output_tokens);
    if (input || output) {
      parts.push(`Token：输入 ${input || '未知'} / 输出 ${output || '未知'}`);
    } else {
      const total = formatTokenCount(usage.total_tokens);
      if (total) parts.push(`Token：总计 ${total}`);
    }
    const cacheRead = formatTokenCount(usage.cache_read_input_tokens);
    const cacheCreation = formatTokenCount(usage.cache_creation_input_tokens);
    if (cacheRead || cacheCreation) {
      parts.push(`Cache：读 ${cacheRead || '0'} / 写 ${cacheCreation || '0'}`);
    }
  }
  return parts;
}

function formatExecutionSourceLabel(summary: RunSummary): string {
  const executorName = summary.executorName?.trim();
  const executorId = summary.executorId?.trim();
  if (executorName && executorId && executorName !== executorId) return `${executorName} (${executorId})`;
  if (executorName || executorId) return executorName || executorId || '';
  return summary.provider?.trim() || '';
}

function formatModelLabel(summary: RunSummary): string {
  const model = summary.model?.trim();
  const source = summary.selectedSource?.trim() || summary.modelSource?.trim();
  if (model && source) return `${model} (${source})`;
  return model || source || '';
}

function formatTokenCount(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return Math.round(value).toLocaleString('en-US');
}

function hasVisibleRationaleSections(text: string): boolean {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return false;
  return /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\u5904\u7406\u601d\u8def(?:\*\*)?/u.test(normalized)
    && /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\u6267\u884c\u7ed3\u679c(?:\*\*)?/u.test(normalized);
}

function extractFinalCardTitleAndBody(content: string): { title: string; body: string } {
  const normalized = stripStandaloneCompletionMarkLines(content.replace(/\r\n/g, '\n')).trim();
  if (hasVisibleRationaleSections(normalized)) {
    return {
      title: summarizeFinalCardTitle('执行结果'),
      body: normalized,
    };
  }
  const heading = /^(?:#{1,6}\s+|\*\*)?(.{2,48}?)(?:\*\*)?\s*[:：]?\s*\n+([\s\S]+)$/u.exec(normalized);
  if (heading && !/[。！？.!?]$/u.test(heading[1].trim())) {
    const body = stripStandaloneCompletionMarkLines(heading[2]).trim();
    if (hasSubstantiveFinalBody(body)) {
      return {
        title: summarizeFinalCardTitle(heading[1], false),
        body,
      };
    }
  }

  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) || '';
  return {
    title: summarizeFinalCardTitle(normalized || firstLine || '回复'),
    body: normalized,
  };
}

function stripStandaloneCompletionMarkLines(content: string): string {
  return (content || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*[✅✔☑❌×]+\s*$/u.test(line))
    .join('\n')
    .trim();
}

function hasSubstantiveFinalBody(content: string): boolean {
  return stripStandaloneCompletionMarkLines(content)
    .split('\n')
    .some((line) => line.trim().length > 0);
}

function summarizeFinalCardTitle(content: string, allowLightweightChat = true): string {
  const cleaned = sanitizeFinalCardTitle(stripFeishuInlineHintText(content));
  if (!cleaned) return '回复';

  if (/自我介绍|^我是|能帮你|可以帮你|主要帮你|帮你处理|陪你聊天/u.test(cleaned)) {
    return '自我介绍';
  }
  if (/表情|贴纸|sticker|满月脸/iu.test(cleaned)) {
    return '表情回复';
  }
  const isLightweightChat = cleaned.length <= 48
    && cleaned.split('\n').filter((line) => line.trim()).length <= 2
    && !/(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|\|.+\|)/u.test(cleaned);
  if (allowLightweightChat && isLightweightChat && /收到|在这儿|在这里|嘿|哈哈|啦|呢|呀|~|～/u.test(cleaned)) {
    return '表情回复';
  }
  if (/^(?:已|已经)?(?:完成|处理|修复|更新|生成|同步|检查|整理|创建|删除|恢复)/u.test(cleaned)) {
    return '处理结果';
  }
  // 只有负向词直接作为标题/开头时才归为未完成；成功摘要正文里可能只是转述“报错”等聊天内容。
  if (/^(?:失败|未完成|报错|错误|阻塞)/u.test(cleaned)) {
    return '未完成';
  }

  const firstClause = cleaned.split(/[。！？.!?；;，,]/u).map((part) => part.trim()).find(Boolean) || cleaned;
  return firstClause || '回复';
}

function stripFeishuInlineHintText(text: string): string {
  return (text || '')
    .replace(/^\s*\[(?:微笑|赞|OK|BULL|牛|表情|表情包|sticker|飞书表情包)(?::|：)?[^\]\r\n]{0,180}\]\s*/iu, '')
    .trim();
}

function sanitizeFinalCardTitle(title: string): string {
  const cleaned = title
    // Card headers are plain text. Keep the visible label but never expose native mention markup.
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/giu, '$1')
    .replace(/<at\b[^>]*\/?\s*>/giu, '')
    .replace(/^[-*>\s#]+/u, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '回复';
  return [...cleaned].slice(0, 48).join('');
}

function formatCompletionMark(status: string): string {
  return /失败|未完成|中断|error|interrupted/i.test(status || '') ? '×' : '✅';
}

function buildFinalCardHeader(status: string, title: string): Record<string, unknown> {
  const normalized = status.trim();
  if (/失败|未完成|error/i.test(normalized)) {
    return {
      title: { tag: 'plain_text', content: title || '回复' },
      template: 'red',
      padding: '12px 12px 12px 12px',
    };
  }
  if (/中断|interrupted/i.test(normalized)) {
    return {
      title: { tag: 'plain_text', content: title || '回复' },
      template: 'orange',
      padding: '12px 12px 12px 12px',
    };
  }
  return {
    title: { tag: 'plain_text', content: title || '回复' },
    template: 'purple',
    padding: '12px 12px 12px 12px',
  };
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
          text_size: 'notation',
        },
      ],
    },
  });
}
