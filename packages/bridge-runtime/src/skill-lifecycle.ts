import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ExtensionActionActor,
  SkillLifecycleApprovalRecord,
  SkillRegistryItem,
  SkillRegistrySnapshot,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { SkillChangeKind, SkillRiskLevel, SkillSourceClass } from 'claude-to-im/src/lib/bridge/agent-architecture.js';
import { CODEX_HOME, CTI_HOME } from './config.js';
import type { OfficialSkillListItem, OfficialSkillTools, SkillValidationResult } from './official-skill-tools.js';
import type { SkillRegistry } from './skill-registry.js';
import { decideSkillSourcePolicy, resolveSkillSourceClass } from './skill-source-policy.js';

export type SkillLifecycleToolset = OfficialSkillTools;

export interface CreateSkillDraftInput {
  name: string;
  displayName: string;
  description: string;
  defaultPrompt: string;
  actor: ExtensionActionActor;
}

export interface PrepareSkillInstallInput {
  id: string;
  sourceClass: SkillSourceClass;
  source: string;
  risk: SkillRiskLevel;
  changeKind: SkillChangeKind;
  actor: ExtensionActionActor;
}

export interface SkillApprovalRecord extends SkillLifecycleApprovalRecord {
  request: PrepareSkillInstallInput;
}

interface ApprovalStore {
  protocol: 'cti-skill-approvals/v1';
  items: SkillApprovalRecord[];
}

export interface SkillLifecycleService {
  snapshot(): SkillRegistrySnapshot;
  search(query: string): Promise<SkillRegistryItem[]>;
  createDraft(input: CreateSkillDraftInput): Promise<SkillRegistryItem>;
  validate(id: string): Promise<SkillRegistryItem>;
  prepareInstall(input: PrepareSkillInstallInput): Promise<SkillApprovalRecord | SkillRegistryItem>;
  confirmInstall(nonce: string, actor: ExtensionActionActor): Promise<SkillRegistryItem>;
  setEnabled(id: string, enabled: boolean, actor: ExtensionActionActor): Promise<SkillRegistryItem>;
  rollback(id: string, actor: ExtensionActionActor): Promise<SkillRegistryItem>;
}

export interface SkillLifecycleOptions {
  registry: SkillRegistry;
  tools: SkillLifecycleToolset;
  ctiHome?: string;
  codexHome?: string;
  now?: () => Date;
  nonceFactory?: () => string;
  whitelistedSources?: readonly string[];
}

const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const APPROVAL_TTL_MS = 10 * 60 * 1000;

function requireSkillId(id: string): string {
  const normalized = id.trim();
  if (!SKILL_ID_RE.test(normalized) || normalized.length > 64) {
    throw new Error('Skill ID 必须由小写字母、数字和连字符组成，且不超过 64 个字符。');
  }
  return normalized;
}

function requireGithubUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Skill 来源必须是 HTTPS GitHub 地址。');
  }
  return parsed.toString();
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRemoveDirectory(candidate: string, root: string): void {
  if (!isInside(candidate, root) || path.resolve(candidate) === path.resolve(root)) {
    throw new Error(`拒绝清理越界目录：${candidate}`);
  }
  fs.rmSync(candidate, { recursive: true, force: true });
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readApprovalStore(filePath: string): ApprovalStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ApprovalStore>;
    if (parsed.protocol === 'cti-skill-approvals/v1' && Array.isArray(parsed.items)) {
      return { protocol: parsed.protocol, items: parsed.items };
    }
  } catch {
    // Missing or damaged pending approvals are treated as expired, never as approved.
  }
  return { protocol: 'cti-skill-approvals/v1', items: [] };
}

function sameActor(left: ExtensionActionActor, right: ExtensionActionActor): boolean {
  return left.channelType === right.channelType
    && left.chatId === right.chatId
    && (left.userId || '') === (right.userId || '');
}

function safeSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:token|secret|password|api[_-]?key))\s*[=:]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .slice(0, 500);
}

export function createSkillLifecycleService(options: SkillLifecycleOptions): SkillLifecycleService {
  const registry = options.registry;
  const tools = options.tools;
  const ctiHome = path.resolve(options.ctiHome || CTI_HOME);
  const codexHome = path.resolve(options.codexHome || CODEX_HOME);
  const now = options.now || (() => new Date());
  const nonceFactory = options.nonceFactory || (() => crypto.randomUUID());
  const approvalPath = path.join(ctiHome, 'data', 'skill-lifecycle-approvals.json');
  const auditPath = path.join(ctiHome, 'data', 'skill-lifecycle-audit.jsonl');
  const stagingRoot = path.join(ctiHome, 'extensions', 'staging', 'skills');
  const backupRoot = path.join(ctiHome, 'extensions', 'backups', 'skills');
  const disabledRoot = path.join(ctiHome, 'extensions', 'disabled', 'skills');
  const installedRoot = path.join(codexHome, 'skills');
  const configuredWhitelist = options.whitelistedSources || [];

  const audit = (action: string, actor: ExtensionActionActor, details: Record<string, unknown>): void => {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const entry = {
      protocol: 'cti-skill-lifecycle-audit/v1',
      at: now().toISOString(),
      action,
      actor: { channelType: actor.channelType, chatId: actor.chatId, userId: actor.userId },
      ...details,
    };
    fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  };

  const persistApproval = (record: SkillApprovalRecord): void => {
    const store = readApprovalStore(approvalPath);
    store.items = store.items.filter((item) => item.nonce !== record.nonce);
    store.items.push(record);
    atomicWriteJson(approvalPath, store);
  };

  const removeApproval = (nonce: string): void => {
    const store = readApprovalStore(approvalPath);
    store.items = store.items.filter((item) => item.nonce !== nonce);
    atomicWriteJson(approvalPath, store);
  };

  const install = async (input: PrepareSkillInstallInput): Promise<SkillRegistryItem> => {
    const id = requireSkillId(input.id);
    const source = input.sourceClass === 'self_created' ? path.resolve(input.source) : requireGithubUrl(input.source);
    const stageDir = path.join(stagingRoot, id);
    const targetDir = path.join(installedRoot, id);
    safeRemoveDirectory(stageDir, stagingRoot);
    fs.mkdirSync(stagingRoot, { recursive: true });

    try {
      if (input.sourceClass === 'self_created') {
        const expectedDraft = path.resolve(registry.draftRoot, id);
        if (source !== expectedDraft || !isInside(source, registry.draftRoot) || !fs.existsSync(path.join(source, 'SKILL.md'))) {
          throw new Error('自建 Skill 必须来自受控草稿目录。');
        }
        fs.cpSync(source, stageDir, { recursive: true, errorOnExist: true });
      } else {
        await tools.installFromGithub({ url: source, destinationRoot: stagingRoot, name: id });
      }
      const validation = await tools.validate(stageDir);
      if (!validation.ok) throw new Error(validation.summary || 'Skill 校验失败。');

      let rollbackPath: string | undefined;
      if (fs.existsSync(targetDir)) {
        const stamp = now().toISOString().replace(/[:.]/gu, '-');
        rollbackPath = path.join(backupRoot, id, stamp);
        fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
        fs.renameSync(targetDir, rollbackPath);
      }

      try {
        fs.mkdirSync(installedRoot, { recursive: true });
        fs.renameSync(stageDir, targetDir);
      } catch (error) {
        if (rollbackPath && fs.existsSync(rollbackPath) && !fs.existsSync(targetDir)) {
          fs.renameSync(rollbackPath, targetDir);
        }
        throw error;
      }

      const refreshed = registry.refresh();
      const scanned = refreshed.items.find((item) => item.id === id);
      if (!scanned) throw new Error('Skill 安装后未被 Registry 发现。');
      const item = registry.upsert({
        ...scanned,
        sourceClass: input.sourceClass,
        source,
        risk: input.risk,
        validation: { ok: true, checkedAt: now().toISOString(), summary: validation.summary },
        rollbackPath,
        failureSummary: undefined,
        state: 'enabled',
        enabled: true,
        updatedAt: now().toISOString(),
      });
      audit('install', input.actor, { skillId: id, sourceClass: input.sourceClass, risk: input.risk, result: 'ok' });
      return item;
    } catch (error) {
      safeRemoveDirectory(stageDir, stagingRoot);
      const existing = registry.read().items.find((item) => item.id === id);
      if (existing) registry.upsert({ ...existing, failureSummary: safeSummary(error), updatedAt: now().toISOString() });
      audit('install', input.actor, { skillId: id, sourceClass: input.sourceClass, risk: input.risk, result: 'failed', failureSummary: safeSummary(error) });
      throw error;
    }
  };

  const createApproval = (input: PrepareSkillInstallInput, requiredRole: 'user' | 'owner'): SkillApprovalRecord => {
    const nonce = nonceFactory();
    const expiresAt = new Date(now().getTime() + APPROVAL_TTL_MS).toISOString();
    const record: SkillApprovalRecord = {
      nonce,
      skillId: input.id,
      requiredRole,
      actor: { channelType: input.actor.channelType, chatId: input.actor.chatId, userId: input.actor.userId },
      expiresAt,
      request: input,
    };
    persistApproval(record);
    const previous = registry.read().items.find((item) => item.id === input.id);
    registry.upsert({
      ...previous,
      id: input.id,
      displayName: previous?.displayName || input.id,
      sourceClass: input.sourceClass,
      source: input.source,
      state: 'approval_pending',
      risk: input.risk,
      enabled: previous?.enabled === true,
      approval: { required: requiredRole, nonce, expiresAt },
      updatedAt: now().toISOString(),
    });
    audit('prepare_install', input.actor, { skillId: input.id, sourceClass: input.sourceClass, risk: input.risk, requiredRole, result: 'pending' });
    return record;
  };

  return {
    snapshot: () => registry.refresh(),

    async search(query) {
      const normalized = query.trim().toLowerCase();
      const local = registry.refresh().items.filter((item) => !normalized
        || item.id.toLowerCase().includes(normalized)
        || item.displayName.toLowerCase().includes(normalized));
      const curated: OfficialSkillListItem[] = await tools.listCurated();
      const existing = new Set(local.map((item) => item.id));
      for (const entry of curated) {
        if (existing.has(entry.name) || (normalized && !entry.name.toLowerCase().includes(normalized))) continue;
        local.push({
          id: entry.name,
          displayName: entry.name,
          sourceClass: 'official_curated',
          source: `https://github.com/openai/skills/tree/main/skills/.curated/${entry.name}`,
          state: 'discovered',
          risk: 'low',
          enabled: false,
          updatedAt: now().toISOString(),
        });
      }
      return local;
    },

    async createDraft(input) {
      const id = requireSkillId(input.name);
      await tools.createDraft({ ...input, name: id, draftRoot: registry.draftRoot });
      const item = registry.refresh().items.find((candidate) => candidate.id === id);
      if (!item) throw new Error('官方创建脚本完成后未发现 Skill 草稿。');
      audit('create_draft', input.actor, { skillId: id, sourceClass: 'self_created', risk: 'low', result: 'ok' });
      return item;
    },

    async validate(id) {
      const normalized = requireSkillId(id);
      const item = registry.read().items.find((candidate) => candidate.id === normalized) || registry.refresh().items.find((candidate) => candidate.id === normalized);
      if (!item?.path) throw new Error(`Skill 不存在或没有可校验路径：${normalized}`);
      const validation: SkillValidationResult = await tools.validate(item.path);
      return registry.upsert({
        ...item,
        validation: { ok: validation.ok, checkedAt: now().toISOString(), summary: validation.summary },
        state: validation.ok ? 'validated' : 'quarantined',
        updatedAt: now().toISOString(),
      });
    },

    async prepareInstall(input) {
      const id = requireSkillId(input.id);
      const manifestWhitelist = registry.read().items
        .filter((item) => item.sourceClass === 'whitelist' && item.source)
        .map((item) => item.source as string);
      const sourceClass = resolveSkillSourceClass({
        source: input.source,
        skillId: id,
        draftRoot: registry.draftRoot,
        whitelistedSources: [...configuredWhitelist, ...manifestWhitelist],
      });
      const source = sourceClass === 'self_created' ? path.resolve(input.source) : requireGithubUrl(input.source);
      const normalized: PrepareSkillInstallInput = { ...input, id, source, sourceClass };
      const installed = fs.existsSync(path.join(installedRoot, normalized.id));
      const action = decideSkillSourcePolicy({ installed, sourceClass: normalized.sourceClass, risk: normalized.risk, changeKind: normalized.changeKind });
      if (action === 'use') {
        const item = registry.refresh().items.find((candidate) => candidate.id === normalized.id);
        if (!item) throw new Error(`已安装 Skill 未被 Registry 发现：${normalized.id}`);
        return item;
      }
      if (action === 'auto_install' || action === 'auto_update') return await install(normalized);
      if (action === 'confirm_user') return createApproval(normalized, 'user');
      if (action === 'confirm_owner') return createApproval(normalized, 'owner');
      throw new Error(`Skill 已进入隔离状态，不能安装：${normalized.id}`);
    },

    async confirmInstall(nonce, actor) {
      const record = readApprovalStore(approvalPath).items.find((item) => item.nonce === nonce);
      if (!record) throw new Error('Skill 安装确认不存在或已失效。');
      if (!sameActor(record.actor, actor)) throw new Error('Skill 安装确认必须由原会话、原用户完成。');
      if (Date.parse(record.expiresAt) <= now().getTime()) {
        removeApproval(nonce);
        throw new Error('Skill 安装确认已过期。');
      }
      const item = await install({ ...record.request, actor });
      removeApproval(nonce);
      return item;
    },

    async setEnabled(id, enabled, actor) {
      const normalized = requireSkillId(id);
      const current = registry.read().items.find((item) => item.id === normalized) || registry.refresh().items.find((item) => item.id === normalized);
      if (!current) throw new Error(`Skill 不存在：${normalized}`);
      const installedDir = path.join(installedRoot, normalized);
      const disabledDir = path.join(disabledRoot, normalized);
      if (enabled && fs.existsSync(disabledDir)) {
        fs.mkdirSync(installedRoot, { recursive: true });
        fs.renameSync(disabledDir, installedDir);
      } else if (!enabled && fs.existsSync(installedDir)) {
        fs.mkdirSync(disabledRoot, { recursive: true });
        safeRemoveDirectory(disabledDir, disabledRoot);
        fs.renameSync(installedDir, disabledDir);
      }
      registry.refresh();
      const item = registry.upsert({
        ...current,
        path: enabled ? installedDir : disabledDir,
        state: enabled ? 'enabled' : 'disabled',
        enabled,
        updatedAt: now().toISOString(),
      });
      audit(enabled ? 'enable' : 'disable', actor, { skillId: normalized, sourceClass: item.sourceClass, risk: item.risk, result: 'ok' });
      return item;
    },

    async rollback(id, actor) {
      const normalized = requireSkillId(id);
      const item = registry.read().items.find((candidate) => candidate.id === normalized);
      if (!item?.rollbackPath || !fs.existsSync(item.rollbackPath)) throw new Error(`Skill 没有可用回滚点：${normalized}`);
      const targetDir = path.join(installedRoot, normalized);
      const stamp = now().toISOString().replace(/[:.]/gu, '-');
      const replacedPath = path.join(backupRoot, normalized, `${stamp}-replaced`);
      fs.mkdirSync(path.dirname(replacedPath), { recursive: true });
      if (fs.existsSync(targetDir)) fs.renameSync(targetDir, replacedPath);
      fs.renameSync(item.rollbackPath, targetDir);
      const scanned = registry.refresh().items.find((candidate) => candidate.id === normalized);
      if (!scanned) throw new Error('回滚完成后 Registry 未发现 Skill。');
      const result = registry.upsert({ ...scanned, sourceClass: item.sourceClass, source: item.source, risk: item.risk, rollbackPath: replacedPath, updatedAt: now().toISOString() });
      audit('rollback', actor, { skillId: normalized, sourceClass: item.sourceClass, risk: item.risk, result: 'ok' });
      return result;
    },
  };
}
