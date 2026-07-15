import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionActionActor,
  ExtensionActionConfirmResult,
  ExtensionActionPrepareResult,
  ExtensionCatalogHost,
  ExtensionCatalogItemSummary,
  ExtensionInstallPrepareInput,
  ExtensionRemovePrepareInput,
} from 'claude-to-im/src/lib/bridge/host.js';
import { CTI_HOME } from './config.js';
import type { SkillLifecycleService } from './skill-lifecycle.js';

const DEFAULT_CONTROL_API = process.env.CTI_CONTROL_API_PUBLIC_BASE_URL
  || `http://${process.env.CTI_CONTROL_API_HOST || process.env.CTI_CONTROL_API_BIND || '127.0.0.1'}:${process.env.CTI_CONTROL_API_PORT || '8788'}`;
const ACTION_TTL_MS = 10 * 60 * 1000;

interface ControlApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

interface ExtensionActionRecord {
  nonce: string;
  action: 'install' | 'remove';
  item: ExtensionCatalogItemSummary;
  url?: string;
  actor: ExtensionActionActor;
  createdAt: string;
  expiresAt: string;
}

interface ExtensionActionStore {
  protocol: 'cti-extension-actions/v1';
  actions: ExtensionActionRecord[];
}

export interface ExtensionCatalogHostOptions {
  ctiHome?: string;
  controlApiBaseUrl?: string;
  token?: string;
  request?: (url: string, body: { command: string; payload: unknown }) => Promise<ControlApiEnvelope<unknown>>;
  nonceFactory?: () => string;
  now?: () => Date;
  lifecycle?: SkillLifecycleService;
}

export function createExtensionCatalogHost(options: ExtensionCatalogHostOptions = {}): ExtensionCatalogHost {
  const ctiHome = options.ctiHome || CTI_HOME;
  const baseUrl = (options.controlApiBaseUrl || DEFAULT_CONTROL_API).replace(/\/+$/, '');
  const token = options.token ?? process.env.CTI_CONTROL_API_AUTH_TOKEN ?? '';
  const now = options.now || (() => new Date());
  const nonceFactory = options.nonceFactory || (() => crypto.randomUUID());
  const lifecycle = options.lifecycle;
  const request = options.request || (async (url, body) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return await response.json() as ControlApiEnvelope<unknown>;
  });

  async function command<T>(commandName: string, payload: unknown): Promise<T> {
    let envelope: ControlApiEnvelope<unknown>;
    try {
      envelope = await request(`${baseUrl}/api/commands`, { command: commandName, payload });
    } catch (error) {
      throw new Error(`面板未在线或 Control API 不可用：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!envelope.ok) {
      throw new Error(envelope.error || 'Control API 返回失败。');
    }
    return envelope.data as T;
  }

  const actionsPath = path.join(ctiHome, 'data', 'extension-install-actions.json');

  function readStore(): ExtensionActionStore {
    try {
      if (!fs.existsSync(actionsPath)) return { protocol: 'cti-extension-actions/v1', actions: [] };
      const parsed = JSON.parse(fs.readFileSync(actionsPath, 'utf8')) as Partial<ExtensionActionStore>;
      return {
        protocol: 'cti-extension-actions/v1',
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      };
    } catch {
      return { protocol: 'cti-extension-actions/v1', actions: [] };
    }
  }

  function writeStore(store: ExtensionActionStore): void {
    fs.mkdirSync(path.dirname(actionsPath), { recursive: true });
    const tmp = `${actionsPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, actionsPath);
  }

  function prune(store: ExtensionActionStore): ExtensionActionStore {
    const timestamp = now().getTime();
    return {
      protocol: 'cti-extension-actions/v1',
      actions: store.actions.filter((action) => new Date(action.expiresAt).getTime() > timestamp),
    };
  }

  function saveAction(action: 'install' | 'remove', input: ExtensionInstallPrepareInput | ExtensionRemovePrepareInput): ExtensionActionPrepareResult {
    const timestamp = now();
    const record: ExtensionActionRecord = {
      nonce: nonceFactory(),
      action,
      item: input.item,
      url: 'url' in input ? input.url : undefined,
      actor: input.actor,
      createdAt: timestamp.toISOString(),
      expiresAt: new Date(timestamp.getTime() + ACTION_TTL_MS).toISOString(),
    };
    const store = prune(readStore());
    store.actions = store.actions.filter((entry) => entry.nonce !== record.nonce);
    store.actions.push(record);
    writeStore(store);
    return {
      ok: true,
      nonce: record.nonce,
      expiresAt: record.expiresAt,
      item: record.item,
      message: action === 'install' ? '等待确认安装。' : '等待确认移除记录。',
    };
  }

  function claimAction(nonce: string, actor: ExtensionActionActor, action: 'install' | 'remove'): ExtensionActionRecord | ExtensionActionConfirmResult {
    const store = readStore();
    const record = store.actions.find((entry) => entry.nonce === nonce && entry.action === action);
    if (!record) return { ok: false, status: 'not_found', message: '确认记录不存在或已处理。' };
    if (record.actor.chatId !== actor.chatId || (record.actor.userId || '') !== (actor.userId || '')) {
      return { ok: false, status: 'forbidden', message: '这条确认只能由原发起人在同一会话里完成。' };
    }
    if (new Date(record.expiresAt).getTime() <= now().getTime()) {
      store.actions = store.actions.filter((entry) => entry.nonce !== nonce);
      writeStore(store);
      return { ok: false, status: 'expired', message: '确认已过期，请重新发起安装或移除。' };
    }
    store.actions = store.actions.filter((entry) => entry.nonce !== nonce);
    writeStore(store);
    return record;
  }

  return {
    async searchExtensions(query: string): Promise<ExtensionCatalogItemSummary[]> {
      const snapshot = await command<{ items?: ExtensionCatalogItemSummary[] }>('extension.catalog.list', {});
      const needle = query.trim().toLowerCase();
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      if (!needle) return items.slice(0, 20);
      return items.filter((item) =>
        [
          item.id,
          item.type,
          item.displayName,
          item.version,
          item.category,
          item.description,
          item.installHandler,
          item.source,
        ].filter(Boolean).join(' ').toLowerCase().includes(needle)
      );
    },
    async previewExtensionUrl(url: string): Promise<ExtensionCatalogItemSummary> {
      return await command<ExtensionCatalogItemSummary>('extension.remote.preview', { url });
    },
    async prepareInstallAction(input: ExtensionInstallPrepareInput): Promise<ExtensionActionPrepareResult> {
      if (input.item.type === 'skill' && lifecycle) {
        const source = input.url || input.item.source;
        if (!source) return { ok: false, item: input.item, error: 'Skill 缺少可验证来源。' };
        try {
          const result = await lifecycle.prepareInstall({
            id: input.item.id,
            sourceClass: 'unknown',
            source,
            risk: input.item.trusted === false ? 'medium' : 'low',
            changeKind: input.item.installed ? 'compatibility' : 'install',
            actor: input.actor,
          });
          if ('nonce' in result) {
            return {
              ok: true,
              nonce: `skill:${result.nonce}`,
              expiresAt: result.expiresAt,
              item: input.item,
              message: result.requiredRole === 'owner' ? '等待 Owner 确认安装。' : '等待用户确认安装。',
            };
          }
          return { ok: true, item: input.item, message: `安装已完成：${result.displayName}` };
        } catch (error) {
          return { ok: false, item: input.item, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return saveAction('install', input);
    },
    async confirmInstallAction(nonce: string, actor: ExtensionActionActor): Promise<ExtensionActionConfirmResult> {
      if (nonce.startsWith('skill:') && lifecycle) {
        try {
          const item = await lifecycle.confirmInstall(nonce.slice('skill:'.length), actor);
          return {
            ok: true,
            status: 'installed',
            item: {
              id: item.id,
              type: 'skill',
              displayName: item.displayName,
              version: item.version,
              source: item.source,
              installed: true,
              trusted: item.sourceClass !== 'third_party' && item.sourceClass !== 'unknown',
            },
            message: `安装已完成：${item.displayName}`,
          };
        } catch (error) {
          return { ok: false, status: 'failed', message: error instanceof Error ? error.message : String(error) };
        }
      }
      const claimed = claimAction(nonce, actor, 'install');
      if ('ok' in claimed && !claimed.ok) return claimed;
      const record = claimed as ExtensionActionRecord;
      const payload = record.url
        ? { url: record.url, allowUntrusted: true }
        : { id: record.item.id, allowUntrusted: false };
      const result = await command<{ displayName?: string; id?: string; type?: string }>('extension.remote.install', payload);
      return {
        ok: true,
        status: 'installed',
        item: record.item,
        message: `安装已完成：${result.displayName || record.item.displayName}`,
      };
    },
    async prepareRemoveAction(input: ExtensionRemovePrepareInput): Promise<ExtensionActionPrepareResult> {
      return saveAction('remove', input);
    },
    async confirmRemoveAction(nonce: string, actor: ExtensionActionActor): Promise<ExtensionActionConfirmResult> {
      const claimed = claimAction(nonce, actor, 'remove');
      if ('ok' in claimed && !claimed.ok) return claimed;
      const record = claimed as ExtensionActionRecord;
      await command('extension.remote.remove', { id: record.item.id, type: record.item.type });
      return {
        ok: true,
        status: 'removed',
        item: record.item,
        message: `记录已移除：${record.item.displayName}`,
      };
    },
  };
}
