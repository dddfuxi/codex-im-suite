import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  PanelSettingChangeContract,
  PanelSettingDescriptorContract,
  PanelSettingsScalar,
  PanelSettingsSnapshotContract,
  PanelSettingsUpdateReceiptContract,
} from '@codex-im-suite/contracts/panel-settings';
import type { PanelSettingsHost } from 'claude-to-im/host';

import { CONFIG_PATH, loadConfig, normalizeExecutorId, type Config } from './config.js';
import { writeUtf8TextAtomic } from './atomic-text-file.js';

interface PanelSettingDefinition extends PanelSettingDescriptorContract {
  envKeys: string[];
  read: (config: Config, env: Map<string, string>) => PanelSettingsScalar;
  normalize?: (value: PanelSettingsScalar) => PanelSettingsScalar;
}

const enumValue = (values: readonly string[]) => (value: PanelSettingsScalar): string => {
  if (typeof value !== 'string') throw new Error('值必须是字符串');
  const normalized = value.trim().toLowerCase();
  if (!values.includes(normalized)) throw new Error(`允许值：${values.join('、')}`);
  return normalized;
};

const boundedInteger = (minimum: number, maximum: number) => (value: PanelSettingsScalar): number => {
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`必须是 ${minimum}–${maximum} 的整数`);
  }
  return number;
};

const booleanValue = (value: PanelSettingsScalar): boolean => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'on', 'yes', '开启', '启用', '是'].includes(normalized)) return true;
  if (['false', '0', 'off', 'no', '关闭', '禁用', '否'].includes(normalized)) return false;
  throw new Error('值必须是布尔值');
};

function normalizedText(value: PanelSettingsScalar): string {
  if (typeof value !== 'string') throw new Error('值必须是字符串');
  const text = value.trim();
  if (/\r|\n|\0/u.test(text)) throw new Error('值不能包含换行或空字符');
  return text;
}

function absolutePath(value: PanelSettingsScalar): string {
  const text = normalizedText(value);
  if (!text || !path.isAbsolute(text)) throw new Error('必须提供绝对路径');
  return path.normalize(text);
}

function absolutePathList(value: PanelSettingsScalar): string {
  const items = normalizedText(value).split(';').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0 || items.some((item) => !path.isAbsolute(item))) {
    throw new Error('必须提供用分号分隔的绝对路径');
  }
  return [...new Set(items.map((item) => path.normalize(item)))].join(';');
}

function safeHttpUrl(value: PanelSettingsScalar): string {
  const text = normalizedText(value);
  if (!text) return '';
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error('必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('只允许不含凭据的 HTTP(S) 地址');
  }
  return text.replace(/\/$/u, '');
}

const SETTINGS: readonly PanelSettingDefinition[] = [
  { key: 'defaultWorkDir', label: '默认工作目录', group: '路径', type: 'path', writable: true, restartRequired: true, envKeys: ['CTI_DEFAULT_WORKDIR'], read: (c) => c.defaultWorkDir, normalize: absolutePath },
  { key: 'allowedRoots', label: '允许的工作区根目录', group: '路径', type: 'path_list', writable: true, restartRequired: true, envKeys: ['CTI_ALLOWED_WORKSPACE_ROOTS'], read: (c) => (c.allowedWorkspaceRoots || []).join(';'), normalize: absolutePathList },
  { key: 'memoryRepo', label: '记忆仓库目录', group: '路径', type: 'path', writable: true, restartRequired: true, envKeys: ['CTI_MEMORY_REPO_DIR'], read: (c) => c.memoryRepoDir || '', normalize: absolutePath },
  { key: 'additionalDirs', label: 'Codex 附加目录', group: '路径', type: 'path_list', writable: false, restartRequired: true, envKeys: [], read: (c) => (c.codexAdditionalDirectories || []).join(';') },
  { key: 'ollamaModelsDir', label: 'Ollama 模型目录', group: '路径', type: 'path', writable: true, restartRequired: true, envKeys: ['CTI_OLLAMA_MODELS_DIR', 'OLLAMA_MODELS'], read: (_c, env) => env.get('CTI_OLLAMA_MODELS_DIR') || env.get('OLLAMA_MODELS') || '', normalize: absolutePath },

  { key: 'replyStyleHint', label: '回复风格', group: '回复与执行', type: 'string', writable: true, restartRequired: true, envKeys: ['CTI_REPLY_STYLE_HINT'], read: (c) => c.replyStyleHint || '', normalize: normalizedText },
  { key: 'defaultExecutorId', label: '默认执行器', group: '回复与执行', type: 'string', writable: true, restartRequired: true, envKeys: ['CTI_DEFAULT_EXECUTOR_ID'], read: (c) => c.defaultExecutorId || '', normalize: (value) => { const text = normalizedText(value); if (!text) return ''; const result = normalizeExecutorId(text); if (!result) throw new Error('执行器 ID 只能包含字母、数字、点、下划线和短横线'); return result; } },
  { key: 'safetyPolicyProfile', label: '安全策略档位', group: '回复与执行', type: 'enum', writable: true, restartRequired: true, enumValues: ['strict', 'balanced', 'fluent'], envKeys: ['CTI_SAFETY_POLICY_PROFILE'], read: (c) => c.safetyPolicyProfile || 'balanced', normalize: enumValue(['strict', 'balanced', 'fluent']) },

  { key: 'localAiKind', label: '本地 AI 类型', group: '本地 AI', type: 'enum', writable: true, restartRequired: true, enumValues: ['ollama', 'lmstudio', 'vllm', 'openai-compatible', 'custom'], envKeys: ['CTI_LOCAL_AI_KIND'], read: (c) => c.localAiKind || 'ollama', normalize: enumValue(['ollama', 'lmstudio', 'vllm', 'openai-compatible', 'custom']) },
  { key: 'localAiBaseUrl', label: '本地 AI 地址', group: '本地 AI', type: 'string', writable: true, restartRequired: true, envKeys: ['CTI_LOCAL_AI_BASE_URL', 'CTI_OLLAMA_BASE_URL'], read: (c) => c.localAiBaseUrl || c.ollamaBaseUrl || '', normalize: safeHttpUrl },
  { key: 'localAiModel', label: '本地 AI 模型', group: '本地 AI', type: 'string', writable: true, restartRequired: true, envKeys: ['CTI_LOCAL_AI_MODEL', 'CTI_OLLAMA_MODEL'], read: (c) => c.localAiModel || c.ollamaModel || '', normalize: normalizedText },
  { key: 'localAiTimeoutMs', label: '本地 AI 超时（毫秒）', group: '本地 AI', type: 'number', writable: true, restartRequired: true, minimum: 1000, maximum: 600000, envKeys: ['CTI_LOCAL_AI_TIMEOUT_MS', 'CTI_OLLAMA_TIMEOUT_MS'], read: (c) => c.localAiTimeoutMs || c.ollamaTimeoutMs || 45000, normalize: boundedInteger(1000, 600000) },
  { key: 'localAiApiKeySet', label: '本地 AI API Key', group: '本地 AI', type: 'secret_status', writable: false, restartRequired: true, envKeys: [], read: (c) => Boolean(c.localAiApiKey) },

  { key: 'codexModelSource', label: 'Codex 模型来源', group: 'Codex', type: 'enum', writable: true, restartRequired: true, enumValues: ['official', 'local_api', 'external_api'], envKeys: ['CTI_CODEX_MODEL_SOURCE'], read: (c) => c.codexModelSource || 'official', normalize: enumValue(['official', 'local_api', 'external_api']) },
  { key: 'codexRoutingMode', label: 'Codex 路由模式', group: 'Codex', type: 'enum', writable: true, restartRequired: true, enumValues: ['manual', 'auto_failover'], envKeys: ['CTI_CODEX_ROUTING_MODE'], read: (c) => c.codexRoutingMode || 'manual', normalize: enumValue(['manual', 'auto_failover']) },
  { key: 'codexApiFallbackChain', label: 'Codex 故障转移顺序', group: 'Codex', type: 'string', writable: true, restartRequired: true, envKeys: ['CTI_CODEX_API_FALLBACK_CHAIN'], read: (c) => (c.codexApiFallbackChain || []).join(','), normalize: (value) => { const values = normalizedText(value).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean); const allowed = ['local_api', 'external_api', 'official']; if (!values.length || values.some((v) => !allowed.includes(v))) throw new Error(`只允许：${allowed.join('、')}`); return [...new Set(values)].join(','); } },
  { key: 'codexBaseUrl', label: 'Codex API 地址', group: 'Codex', type: 'string', writable: true, restartRequired: true, envKeys: ['CTI_CODEX_BASE_URL'], read: (c) => c.codexBaseUrl || '', normalize: safeHttpUrl },
  { key: 'codexModel', label: 'Codex 模型', group: 'Codex', type: 'string', writable: true, restartRequired: true, envKeys: ['CTI_CODEX_MODEL', 'CTI_CODEX_PASS_MODEL'], read: (c) => c.codexModel || '', normalize: normalizedText },
  { key: 'codexPassModel', label: '显式传递 Codex 模型', group: 'Codex', type: 'boolean', writable: false, restartRequired: true, envKeys: [], read: (c) => Boolean(c.codexPassModel) },
  { key: 'codexReasoningEffort', label: 'Codex 推理强度', group: 'Codex', type: 'enum', writable: true, restartRequired: true, enumValues: ['minimal', 'low', 'medium', 'high', 'xhigh'], envKeys: ['CTI_CODEX_REASONING_EFFORT'], read: (c) => c.codexReasoningEffort || 'low', normalize: enumValue(['minimal', 'low', 'medium', 'high', 'xhigh']) },
  { key: 'codexApiKeySet', label: 'Codex API Key', group: 'Codex', type: 'secret_status', writable: false, restartRequired: true, envKeys: [], read: (c) => Boolean(c.codexApiKey) },

  { key: 'memoryOptimizerEnabled', label: '启用记忆整理', group: '记忆整理', type: 'boolean', writable: true, restartRequired: true, envKeys: ['CTI_MEMORY_OPTIMIZER_ENABLED'], read: (c) => Boolean(c.memoryOptimizerEnabled), normalize: booleanValue },
  { key: 'memoryOptimizerIntervalDays', label: '记忆整理间隔（天）', group: '记忆整理', type: 'number', writable: true, restartRequired: true, minimum: 1, maximum: 365, envKeys: ['CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS'], read: (c) => c.memoryOptimizerIntervalDays || 7, normalize: boundedInteger(1, 365) },
  { key: 'memoryOptimizerModelSource', label: '记忆整理模型来源', group: '记忆整理', type: 'enum', writable: true, restartRequired: true, enumValues: ['codex_primary', 'local_ai', 'external_api'], envKeys: ['CTI_MEMORY_OPTIMIZER_MODEL_SOURCE'], read: (c) => c.memoryOptimizerModelSource || 'codex_primary', normalize: enumValue(['codex_primary', 'local_ai', 'external_api']) },
] as const;

function readConfigText(configPath: string): string {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
}

function parseEnv(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    result.set(line.slice(0, index).trim(), line.slice(index + 1));
  }
  return result;
}

function versionOf(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function serializeValue(value: PanelSettingsScalar): string {
  return typeof value === 'boolean' ? String(value) : String(value);
}

function patchEnvText(content: string, entries: Map<string, string>): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content ? content.split(/\r?\n/u) : [];
  const touched = new Set<string>();
  const updated = lines.map((line) => {
    const index = line.indexOf('=');
    if (index <= 0 || line.trimStart().startsWith('#')) return line;
    const key = line.slice(0, index).trim();
    if (!entries.has(key) || touched.has(key)) return line;
    touched.add(key);
    return `${key}=${entries.get(key)}`;
  });
  for (const [key, value] of entries) {
    if (!touched.has(key)) updated.push(`${key}=${value}`);
  }
  while (updated.length > 0 && updated.at(-1) === '') updated.pop();
  return `${updated.join(newline)}${newline}`;
}

function buildSnapshot(configPath: string): PanelSettingsSnapshotContract {
  const content = readConfigText(configPath);
  const env = parseEnv(content);
  const config = loadConfig(configPath);
  return {
    protocol: 'cti-panel-settings-snapshot/v1',
    version: versionOf(content),
    generatedAt: new Date().toISOString(),
    settings: SETTINGS.map(({ envKeys: _envKeys, normalize: _normalize, read, ...descriptor }) => ({
      ...descriptor,
      value: read(config, env),
    })),
  };
}

function acquireLock(lockPath: string): () => void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let handle: number;
  try {
    handle = fs.openSync(lockPath, 'wx');
  } catch {
    throw new Error('设置文件正在被其他进程更新，请稍后重试');
  }
  return () => {
    try { fs.closeSync(handle); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  };
}

export function createPanelSettingsHost(options: { configPath?: string } = {}): PanelSettingsHost {
  const configPath = options.configPath || CONFIG_PATH;
  return {
    async list(input) {
      if (input.actor.role !== 'owner' || !input.actor.userId.trim()) throw new Error('panel_settings_owner_required');
      return buildSnapshot(configPath);
    },
    async update(input): Promise<PanelSettingsUpdateReceiptContract> {
      if (input.actor.role !== 'owner' || !input.actor.userId.trim()) throw new Error('panel_settings_owner_required');
      if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 10) {
        throw new Error('每次必须修改 1–10 个设置');
      }
      const release = acquireLock(`${configPath}.panel-settings.lock`);
      try {
        const content = readConfigText(configPath);
        const currentVersion = versionOf(content);
        if (input.expectedVersion && input.expectedVersion !== currentVersion) {
          throw new Error('设置已被其他入口修改，请先重新读取当前设置');
        }
        const before = buildSnapshot(configPath);
        const beforeByKey = new Map(before.settings.map((setting) => [setting.key, setting.value]));
        const entries = new Map<string, string>();
        const applied: PanelSettingsUpdateReceiptContract['applied'] = [];
        const seen = new Set<string>();
        for (const change of input.changes as PanelSettingChangeContract[]) {
          const definition = SETTINGS.find((item) => item.key === change.key);
          if (!definition) throw new Error(`未知设置：${change.key}`);
          if (!definition.writable || definition.envKeys.length === 0) throw new Error(`设置不可通过语音修改：${change.key}`);
          if (seen.has(change.key)) throw new Error(`设置重复：${change.key}`);
          seen.add(change.key);
          const value = definition.normalize ? definition.normalize(change.value) : change.value;
          for (const envKey of definition.envKeys) entries.set(envKey, serializeValue(value));
          if (change.key === 'codexModel') entries.set('CTI_CODEX_PASS_MODEL', String(Boolean(String(value).trim())));
          applied.push({ key: change.key, previousValue: beforeByKey.get(change.key) ?? '', value });
        }
        const nextContent = patchEnvText(content, entries);
        writeUtf8TextAtomic(configPath, nextContent);
        const snapshot = buildSnapshot(configPath);
        return {
          protocol: 'cti-panel-settings-update-receipt/v1',
          ok: true,
          written: true,
          restartRequired: applied.some((change) => SETTINGS.find((item) => item.key === change.key)?.restartRequired),
          version: snapshot.version,
          applied,
          snapshot,
        };
      } finally {
        release();
      }
    },
  };
}

export const PANEL_SETTING_KEYS = SETTINGS.map((setting) => setting.key);
