import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from './config.js';
import {
  buildLocalRoutePrompt,
  compressConversationHistory,
  compressPromptText,
  createLocalOnlyLimitMessage,
  parseLocalRoutePayload,
  type LocalRouteProtocolResult,
  type LocalTaskKind,
} from './local-llm-router.js';
import type { LocalRouterMode } from './local-llm-status.js';

interface ChatCompletionChoice {
  message?: {
    content?: unknown;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  usage?: Record<string, unknown>;
}

export interface LocalModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function trimText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function truncateText(text: string, maxChars: number): string {
  const normalized = trimText(text);
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function extractContent(response: ChatCompletionResponse): string {
  const raw = response.choices?.[0]?.message?.content;
  if (typeof raw === 'string') return trimText(raw);
  if (Array.isArray(raw)) {
    return trimText(
      raw
        .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text || '') : ''))
        .join(''),
    );
  }
  return '';
}

function looksUnsafe(text: string): string | null {
  const normalized = text.toLowerCase();
  if (!normalized) return '响应为空';
  if (normalized.includes('<think>') || normalized.includes('</think>')) return '响应包含思维标签';
  if (/(我已经|已为你|已经帮你).*(执行|修改|运行|导入|删除|发布|创建)/.test(text)) {
    return '响应疑似伪造执行结果';
  }
  return null;
}

function buildAnswerMessages(
  params: StreamChatParams,
  config: Config,
  options: {
    route?: LocalRouteProtocolResult;
    mode: LocalRouterMode;
    bestEffort?: boolean;
    limitReason?: string;
    taskKind?: LocalTaskKind | string;
    commandDraftOnly?: boolean;
  },
): LocalModelMessage[] {
  const route = options.route;
  const prompt = route?.compressedPrompt || compressPromptText(params, config);
  const history = route?.compressedHistory || compressConversationHistory(params, config);
  const systemLines = [
    '你是本地低成本代码助手。',
    '你的职责是给出解释、总结、命令草案、小脚本草案和轻量代码说明。',
    '不要声称你已经执行命令、修改仓库、运行 Unity、操作 Blender、创建或删除飞书文档。',
    '用户侧输出保持简洁中文，只给关键结论，不要暴露长思考过程。',
  ];

  if (options.bestEffort) {
    systemLines.push('当前更强模型不可用或不允许升级。你只能尽力给出解释、建议和草案，不能伪造真实执行结果。');
  }
  if (options.limitReason) {
    systemLines.push(`限制说明：${options.limitReason}`);
  }
  if (route?.suggestedReplyMode) {
    systemLines.push(`回答形式偏好：${route.suggestedReplyMode}`);
  }
  if (options.commandDraftOnly || route?.taskKind === 'command_draft') {
    systemLines.push('如果请求是在要命令草案，优先只返回命令本体或极短说明。');
  }

  const userLines = [
    history ? `最近相关上下文:\n${history}` : '',
    `当前请求:\n${prompt}`,
  ].filter(Boolean);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n\n') },
  ];
}

export class LocalLlamaProvider {
  constructor(private readonly config: Config) {}

  async complete(
    messages: LocalModelMessage[],
    options?: { temperature?: number; maxTokens?: number; timeoutMs?: number },
  ): Promise<{ text: string; usage?: Record<string, unknown> }> {
    const baseUrl = (this.config.localLlmBaseUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    const endpoint = `${baseUrl}/v1/chat/completions`;
    const timeoutMs = Math.max(5000, options?.timeoutMs || this.config.localLlmTimeoutMs || 45000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.localLlmModel || 'qwen2.5-coder-7b-instruct',
          messages,
          stream: false,
          temperature: options?.temperature ?? 0.1,
          max_tokens: Math.max(128, options?.maxTokens || this.config.localLlmMaxOutputTokens || 768),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const json = await response.json() as ChatCompletionResponse;
      const text = extractContent(json);
      const unsafeReason = looksUnsafe(text);
      if (unsafeReason) throw new Error(unsafeReason);
      return { text, usage: json.usage };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`本地模型超时(${timeoutMs}ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async route(params: StreamChatParams): Promise<{ route: LocalRouteProtocolResult; usage?: Record<string, unknown>; rawText: string }> {
    const result = await this.complete(
      [
        {
          role: 'user',
          content: buildLocalRoutePrompt(params, this.config),
        },
      ],
      {
        temperature: 0,
        maxTokens: 256,
        timeoutMs: Math.max(4000, this.config.localLlmRouterTimeoutMs || 12000),
      },
    );
    const route = parseLocalRoutePayload(result.text, params, this.config);
    return { route, usage: result.usage, rawText: result.text };
  }

  async answer(
    params: StreamChatParams,
    options: {
      route?: LocalRouteProtocolResult;
      mode: LocalRouterMode;
      bestEffort?: boolean;
      limitReason?: string;
      taskKind?: LocalTaskKind | string;
      commandDraftOnly?: boolean;
    },
  ): Promise<{ text: string; usage?: Record<string, unknown> }> {
    const messages = buildAnswerMessages(params, this.config, options);
    const result = await this.complete(messages, { temperature: 0.15 });
    return result;
  }

  buildLocalOnlyMessage(taskKind: string, reason: string, commandDraftOnly = false): string {
    return createLocalOnlyLimitMessage(reason, taskKind, commandDraftOnly);
  }

  buildLimitAnswer(
    params: StreamChatParams,
    taskKind: string,
    reason: string,
    commandDraftOnly = false,
  ): Promise<{ text: string; usage?: Record<string, unknown> }> {
    return this.answer(params, {
      mode: 'local_only',
      bestEffort: true,
      limitReason: createLocalOnlyLimitMessage(reason, taskKind, commandDraftOnly),
      taskKind,
      commandDraftOnly,
    });
  }

  buildBestEffortAnswer(
    params: StreamChatParams,
    reason: string,
    taskKind: string,
  ): Promise<{ text: string; usage?: Record<string, unknown> }> {
    return this.answer(params, {
      mode: 'local_only',
      bestEffort: true,
      limitReason: truncateText(reason, 180),
      taskKind,
    });
  }
}
