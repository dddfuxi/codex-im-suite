import type { RunSummary, ToolCallInfo } from '../types.js';

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
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
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
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
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
  const lines = tools.map((tc) => {
    const status = formatToolStatus(tc.status);
    return `${status} · ${formatVisibleToolName(tc.name)}`;
  });
  return lines.join('\n');
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

function formatStreamingStageRail(title: string): string {
  const stages = [
    { label: '依据确认', color: title === '确认证据' ? 'purple' : 'grey' },
    { label: '工具完成', color: title === '调用工具' ? 'purple' : 'grey' },
    { label: '结果生成', color: title === '整理回复' ? 'purple' : 'grey' },
  ];
  return stages.map((stage) => `<font color="${stage.color}">${stage.label}</font>`).join(' · ');
}

export function buildStreamingStepContent(step: string, tools: ToolCallInfo[] = []): string {
  const currentStep = step.trim() || '正在根据这条消息判断下一步。';
  const title = inferStreamingStepTitle(currentStep, tools);
  return buildStreamingStepContentWithTitle(title, currentStep);
}

function buildStreamingStepContentWithTitle(title: string, step: string): string {
  return [
    `<font color="purple">**${title}**</font>`,
    `<font color="grey">${escapeFeishuInlineMarkdown(step)}</font>`,
    '',
    formatStreamingStageRail(title),
  ].join('\n');
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
  return buildStreamingStepContentWithTitle(inferStreamingStepTitle(currentStep, tools), visibleStep);
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
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Main result content. Preserve concise user-visible rationale when present.
  let content = stripStandaloneCompletionMarkLines(preprocessFeishuMarkdown(extractStreamingFinalResponse(text)));
  if (!content.trim()) {
    content = '未完成：模型没有返回可展示结果。';
  }
  const titledContent = extractFinalCardTitleAndBody(content);

  elements.push({
    tag: 'markdown',
    content: titledContent.body,
    text_align: 'left',
    text_size: 'normal',
  });

  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `<font color="grey">**工具轨迹**</font>\n${toolMd}`,
      text_align: 'left',
      text_size: 'notation',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    parts.push(formatCompletionMark(footer.status));
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

  const header = buildFinalCardHeader(footer?.status || '', titledContent.title);

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header,
    body: { elements },
  });
}

function formatRunSummaryFooterParts(summary?: RunSummary): string[] {
  if (!summary) return [];
  const parts: string[] = [];
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

function formatModelLabel(summary: RunSummary): string {
  const model = summary.model?.trim();
  const source = summary.selectedSource?.trim() || summary.modelSource?.trim() || summary.provider?.trim();
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
      title: summarizeFinalCardTitle('????'),
      body: normalized,
    };
  }
  const heading = /^(?:#{1,6}\s+|\*\*)?(.{2,48}?)(?:\*\*)?\s*[:：]?\s*\n+([\s\S]+)$/u.exec(normalized);
  if (heading && !/[。！？.!?]$/u.test(heading[1].trim())) {
    const body = stripStandaloneCompletionMarkLines(heading[2]).trim();
    if (hasSubstantiveFinalBody(body)) {
      return {
        title: summarizeFinalCardTitle(heading[1]),
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

function summarizeFinalCardTitle(content: string): string {
  const cleaned = sanitizeFinalCardTitle(stripFeishuInlineHintText(content));
  if (!cleaned) return '回复';

  if (/自我介绍|^我是|能帮你|可以帮你|主要帮你|帮你处理|陪你聊天/u.test(cleaned)) {
    return '自我介绍';
  }
  if (/表情|满月脸|收到|在这儿|在这里|嘿|哈哈|啦|呢|呀|~|～/u.test(cleaned)) {
    return '表情回复';
  }
  if (/^(?:已|已经)?(?:完成|处理|修复|更新|生成|同步|检查|整理|创建|删除|恢复)/u.test(cleaned)) {
    return '处理结果';
  }
  if (/失败|未完成|报错|错误|阻塞/u.test(cleaned)) {
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
