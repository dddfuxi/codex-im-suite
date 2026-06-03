import type { ToolCallInfo } from '../types.js';

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
    const status = tc.status === 'running' ? '执行中' : tc.status === 'complete' ? '已完成' : '失败';
    return `- ${status}：${formatVisibleToolName(tc.name)}`;
  });
  return lines.join('\n');
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

/**
 * Build the body elements array for a streaming card update.
 * Combines main text content with tool progress.
 */
export function buildStreamingContent(text: string, tools: ToolCallInfo[]): string {
  let content = text || '';
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }
  return content || '### 处理进度\n- 已收到请求，正在进入执行链。';
}

/**
 * Streaming cards show progress while the task is running. Once the same card
 * is finalized, keep only the user-facing result section if the model provided
 * a separate rationale + result structure.
 */
export function extractStreamingFinalResponse(text: string): string {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const resultHeading = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?执行结果(?:\*\*)?\s*[:：]?[ \t]*(?:\n)?/u;
  const match = resultHeading.exec(normalized);
  if (!match) return normalized;

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
): string {
  const elements: Array<Record<string, unknown>> = [];

  const statusLine = footer?.status ? `**状态：${footer.status}**` : '**状态：已完成**';
  elements.push({
    tag: 'markdown',
    content: statusLine,
    text_align: 'left',
    text_size: 'normal',
  });

  // Main result content. Waiting/progress rationale is stripped before finalizing.
  let content = preprocessFeishuMarkdown(extractStreamingFinalResponse(text));
  if (!content.trim()) {
    content = '未完成：模型没有返回可展示结果。';
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `### 最终结果\n${content}`,
    text_align: 'left',
    text_size: 'normal',
  });

  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `### 工具轨迹\n${toolMd}`,
      text_align: 'left',
      text_size: 'notation',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    if (footer.elapsed) parts.push(footer.elapsed);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: `耗时：${parts.join(' · ')}`,
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
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
