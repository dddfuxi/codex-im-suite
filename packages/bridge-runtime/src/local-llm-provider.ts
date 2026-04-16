import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from './config.js';
import { sseEvent } from './sse-utils.js';

interface ChatCompletionChoice {
  message?: {
    content?: unknown;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  usage?: Record<string, unknown>;
}

function trimText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
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

function buildMessages(params: StreamChatParams): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  const systemLines = [
    '你是本地低成本代码助手，只负责低复杂度代码杂活。',
    '不要声称你已经执行命令、修改仓库、运行 Unity、操作 Blender、发布或删除任何内容。',
    '你只能返回建议、摘要、命令草案、脚本草案或代码解释。',
    '用户可见输出保持简洁中文，直接给结论。',
  ];
  if (params.systemPrompt?.trim()) systemLines.push(params.systemPrompt.trim());
  messages.push({ role: 'system', content: systemLines.join('\n') });

  for (const item of params.conversationHistory || []) {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: item.content });
  }
  messages.push({ role: 'user', content: params.prompt });
  return messages;
}

function looksUnsafe(text: string): string | null {
  const normalized = text.toLowerCase();
  if (!normalized) return '响应为空';
  if (normalized.includes('<think>') || normalized.includes('</think>')) return '响应包含思维标签';
  if (/(我已经(修改|执行|运行|导入|删除|发布)|已为你(修改|执行|运行|导入|删除|发布))/.test(text)) {
    return '响应疑似伪造执行结果';
  }
  return null;
}

export class LocalLlamaProvider implements LLMProvider {
  constructor(private readonly config: Config) {}

  async run(params: StreamChatParams): Promise<{ text: string; usage?: Record<string, unknown> }> {
    const baseUrl = (this.config.localLlmBaseUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    const endpoint = `${baseUrl}/v1/chat/completions`;
    const timeoutMs = Math.max(5000, this.config.localLlmTimeoutMs || 45000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.localLlmModel || 'qwen2.5-coder-7b-instruct',
          messages: buildMessages(params),
          stream: false,
          temperature: 0.1,
          max_tokens: Math.max(128, this.config.localLlmMaxOutputTokens || 768),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const json = await response.json() as ChatCompletionResponse;
      const text = extractContent(json);
      const unsafeReason = looksUnsafe(text);
      if (unsafeReason) {
        throw new Error(unsafeReason);
      }
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

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          const result = await this.run(params);
          controller.enqueue(sseEvent('status', { provider: 'local-llama' }));
          controller.enqueue(sseEvent('text', result.text));
          controller.enqueue(sseEvent('result', {
            subtype: 'success',
            is_error: false,
            session_id: params.sessionId,
            usage: result.usage || {},
          }));
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(sseEvent('error', message));
          controller.close();
        }
      },
    });
  }
}
