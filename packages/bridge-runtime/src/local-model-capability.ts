import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME, type Config } from './config.js';
import { updateLocalLlmStatus, type LocalModelRecommendation } from './local-llm-status.js';

export type ToolCallingState = 'untested' | 'passed' | 'failed' | 'text_only';

export interface LocalModelCapabilityProfile {
  schema: 'codex-im-suite/local-model-capabilities/v1';
  updatedAt: string;
  provider: string;
  baseUrl: string;
  model: string;
  toolCallingState: ToolCallingState;
  recommendedMode: 'text_only' | 'agent_verified';
  message: string;
  evidence?: {
    endpoint?: string;
    toolCallCount?: number;
    toolNames?: string[];
    finishReason?: string;
    rawContentPreview?: string;
  };
  recommendations: LocalModelRecommendation[];
}

export const RECOMMENDED_LOCAL_MODELS: LocalModelRecommendation[] = [
  {
    model: 'qwen3-coder-next:latest',
    provider: 'ollama',
    label: 'Qwen3 Coder Next',
    role: 'strong_tool_candidate',
    minMemoryGb: 64,
    notes: 'Qwen 新一代 coding agent 候选，约 52GB；适合高配机器测试本地 Codex agent 主模型。',
  },
  {
    model: 'qwen3-coder-next:q4_K_M',
    provider: 'ollama',
    label: 'Qwen3 Coder Next Q4_K_M',
    role: 'strong_tool_candidate',
    minMemoryGb: 64,
    notes: '固定 Q4_K_M 标签，约 52GB；资源要求高于 30B A3B。',
  },
  {
    model: 'qwen3-coder:30b',
    provider: 'ollama',
    label: 'Qwen3 Coder 30B A3B',
    role: 'strong_tool_candidate',
    minMemoryGb: 24,
    notes: '当前优先推荐的 Qwen 本地代码 agent 候选；安装后仍需跑工具调用探测。',
  },
  {
    model: 'qwen3-coder:30b-a3b-q4_K_M',
    provider: 'ollama',
    label: 'Qwen3 Coder 30B A3B Q4_K_M',
    role: 'strong_tool_candidate',
    minMemoryGb: 24,
    notes: '固定量化标签，约 19GB；适合不想依赖 latest/30b 别名的本地安装。',
  },
  {
    model: 'qwen3-coder:30b-a3b-q8_0',
    provider: 'ollama',
    label: 'Qwen3 Coder 30B A3B Q8',
    role: 'strong_tool_candidate',
    minMemoryGb: 40,
    notes: '更高精度版本，资源占用更高；适合内存/显存更充足时测试。',
  },
  {
    model: 'qwen3:14b',
    provider: 'ollama',
    label: 'Qwen3 14B',
    role: 'tool_candidate',
    minMemoryGb: 16,
    notes: '优先测试的本地工具调用候选；通过探测后再允许执行类任务。',
  },
  {
    model: 'qwen3:30b',
    provider: 'ollama',
    label: 'Qwen3 30B A3B',
    role: 'strong_tool_candidate',
    minMemoryGb: 24,
    notes: '更强的本地 Agent 候选，适合高配机器或独立推理机。',
  },
  {
    model: 'qwen3:32b',
    provider: 'ollama',
    label: 'Qwen3 32B',
    role: 'strong_tool_candidate',
    minMemoryGb: 32,
    notes: '多步工具规划比 7B/8B 更稳，仍需先跑工具探测。',
  },
  {
    model: 'qwen2.5:32b',
    provider: 'ollama',
    label: 'Qwen2.5 32B',
    role: 'tool_candidate',
    minMemoryGb: 24,
    notes: '中文和结构化输出较稳，可作为 Qwen3 之外的工具候选。',
  },
  {
    model: 'llama3.3:70b',
    provider: 'vllm',
    label: 'Llama 3.3 70B',
    role: 'strong_tool_candidate',
    minMemoryGb: 48,
    notes: '适合 vLLM/独立推理机；需要服务端启用对应 tool parser。',
  },
  {
    model: 'qwen2.5-coder:7b',
    provider: 'ollama',
    label: 'Qwen2.5 Coder 7B',
    role: 'text',
    minMemoryGb: 8,
    notes: '适合总结、解释、草稿，不建议承担真实执行类任务。',
  },
];

const CAPABILITY_PATH = path.join(CTI_HOME, 'runtime', 'local-model-capabilities.json');

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeBaseUrl(baseUrl: string, provider: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:8000/v1';
  if (provider === 'ollama' && !/\/v1$/i.test(trimmed)) return `${trimmed}/v1`;
  return trimmed;
}

function preview(value: unknown, max = 240): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function currentProvider(config: Config): string {
  return (config.localAiKind || 'ollama').trim().toLowerCase();
}

export function getLocalModelBaseUrl(config: Config): string {
  return normalizeBaseUrl(
    config.localAiBaseUrl || config.ollamaBaseUrl || config.localLlmBaseUrl || 'http://127.0.0.1:11434',
    currentProvider(config),
  );
}

export function getLocalModelName(config: Config): string {
  return (config.localAiModel || config.ollamaModel || config.localLlmModel || 'qwen2.5-coder:7b').trim();
}

function buildProfile(
  config: Config,
  patch: Partial<LocalModelCapabilityProfile>,
): LocalModelCapabilityProfile {
  const provider = currentProvider(config);
  return {
    schema: 'codex-im-suite/local-model-capabilities/v1',
    updatedAt: nowIso(),
    provider,
    baseUrl: getLocalModelBaseUrl(config),
    model: getLocalModelName(config),
    toolCallingState: 'untested',
    recommendedMode: 'text_only',
    message: '尚未测试工具调用能力。',
    recommendations: RECOMMENDED_LOCAL_MODELS,
    ...patch,
  };
}

export function readLocalModelCapabilityProfile(config: Config): LocalModelCapabilityProfile {
  const fallback = buildProfile(config, {});
  try {
    if (!fs.existsSync(CAPABILITY_PATH)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(CAPABILITY_PATH, 'utf-8')) as Partial<LocalModelCapabilityProfile>;
    return {
      ...fallback,
      ...parsed,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : RECOMMENDED_LOCAL_MODELS,
    };
  } catch {
    return fallback;
  }
}

export function writeLocalModelCapabilityProfile(config: Config, profile: LocalModelCapabilityProfile): LocalModelCapabilityProfile {
  fs.mkdirSync(path.dirname(CAPABILITY_PATH), { recursive: true });
  fs.writeFileSync(CAPABILITY_PATH, JSON.stringify(profile, null, 2), 'utf-8');
  updateLocalLlmStatus(config, {
    toolCallingState: profile.toolCallingState,
    toolCallingCheckedAt: profile.updatedAt,
    toolCallingModel: profile.model,
    toolCallingBaseUrl: profile.baseUrl,
    toolCallingMessage: profile.message,
    toolCallingRecommendedMode: profile.recommendedMode,
    recommendedModels: profile.recommendations,
  });
  return profile;
}

export function isLocalToolCallingVerified(config: Config): boolean {
  const profile = readLocalModelCapabilityProfile(config);
  return profile.model === getLocalModelName(config)
    && profile.baseUrl === getLocalModelBaseUrl(config)
    && profile.toolCallingState === 'passed';
}

export function shouldTrustLocalApiForExecution(config: Config): boolean {
  if (config.localToolCallRequired === false) return true;
  return config.localAgentMode === 'agent_verified' && isLocalToolCallingVerified(config);
}

export async function probeLocalModelCapabilities(config: Config): Promise<LocalModelCapabilityProfile> {
  const endpoint = `${getLocalModelBaseUrl(config).replace(/\/+$/, '')}/chat/completions`;
  const model = getLocalModelName(config);
  const toolName = 'cti_probe_echo';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, config.localAiTimeoutMs || 45000));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.localAiApiKey) headers.Authorization = `Bearer ${config.localAiApiKey}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: 96,
        messages: [
          { role: 'system', content: 'Return a structured tool call when a tool is needed. Do not answer in prose.' },
          { role: 'user', content: 'Use the probe tool with marker cti-tool-probe.' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: toolName,
              description: 'Echo a marker for local tool-call capability probing.',
              parameters: {
                type: 'object',
                required: ['marker'],
                properties: {
                  marker: { type: 'string', description: 'The marker to echo.' },
                },
              },
            },
          },
        ],
        tool_choice: 'auto',
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      return writeLocalModelCapabilityProfile(config, buildProfile(config, {
        toolCallingState: 'failed',
        recommendedMode: 'text_only',
        message: `工具探测请求失败：HTTP ${response.status} ${response.statusText} | ${preview(raw)}`,
        evidence: { endpoint, rawContentPreview: preview(raw) },
      }));
    }

    const json = JSON.parse(raw) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: unknown;
          tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
        };
      }>;
    };
    const choice = json.choices?.[0];
    const calls = choice?.message?.tool_calls || [];
    const toolNames = calls.map((call) => call.function?.name || '').filter(Boolean);
    const matched = calls.some((call) => call.function?.name === toolName);
    if (!matched) {
      return writeLocalModelCapabilityProfile(config, buildProfile(config, {
        toolCallingState: 'text_only',
        recommendedMode: 'text_only',
        message: '本地 API 在线，但没有返回结构化 tool_calls；新路由不会因此自动转官方 Codex。',
        evidence: {
          endpoint,
          toolCallCount: calls.length,
          toolNames,
          finishReason: choice?.finish_reason,
          rawContentPreview: preview(choice?.message?.content ?? raw),
        },
      }));
    }

    return writeLocalModelCapabilityProfile(config, buildProfile(config, {
      toolCallingState: 'passed',
      recommendedMode: 'agent_verified',
      message: '本地 API 已返回结构化 tool_calls；可作为受控工具模型候选，仍需运行时执行证据验收。',
      evidence: {
        endpoint,
        toolCallCount: calls.length,
        toolNames,
        finishReason: choice?.finish_reason,
        rawContentPreview: preview(choice?.message?.content ?? raw),
      },
    }));
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? `工具探测超时：${config.localAiTimeoutMs || 45000}ms`
      : `工具探测失败：${error instanceof Error ? error.message : String(error)}`;
    return writeLocalModelCapabilityProfile(config, buildProfile(config, {
      toolCallingState: 'failed',
      recommendedMode: 'text_only',
      message,
    }));
  } finally {
    clearTimeout(timer);
  }
}
