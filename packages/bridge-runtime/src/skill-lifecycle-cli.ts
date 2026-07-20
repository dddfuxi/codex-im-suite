#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionActionActor } from 'claude-to-im/host';
import { createOfficialSkillTools } from './official-skill-tools.js';
import { createSkillLifecycleService, type SkillLifecycleService } from './skill-lifecycle.js';
import { createSkillRegistry } from './skill-registry.js';

function readInput(argv: string[]): Record<string, unknown> {
  const index = argv.indexOf('--input-base64');
  if (index < 0) return {};
  const encoded = argv[index + 1] || '';
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('CLI 输入无效：--input-base64 必须是 UTF-8 JSON 对象。');
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`CLI 输入缺少 ${key}。`);
  return value;
}

function requireActor(input: Record<string, unknown>): ExtensionActionActor {
  const actor = input.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) throw new Error('CLI 输入缺少 actor。');
  const value = actor as Record<string, unknown>;
  return {
    channelType: requireString(value, 'channelType'),
    chatId: requireString(value, 'chatId'),
    userId: typeof value.userId === 'string' ? value.userId : undefined,
    messageId: typeof value.messageId === 'string' ? value.messageId : undefined,
  };
}

export async function executeSkillLifecycleCommand(argv: string[], service: SkillLifecycleService): Promise<unknown> {
  const command = argv[0] || 'snapshot';
  const input = readInput(argv);
  switch (command) {
    case 'snapshot':
      return service.snapshot();
    case 'search':
      return await service.search(typeof input.query === 'string' ? input.query : '');
    case 'create-draft':
      return await service.createDraft({
        name: requireString(input, 'name'),
        displayName: requireString(input, 'displayName'),
        description: requireString(input, 'description'),
        defaultPrompt: requireString(input, 'defaultPrompt'),
        actor: requireActor(input),
      });
    case 'validate':
      return await service.validate(requireString(input, 'id'));
    case 'prepare-install':
      return await service.prepareInstall({
        id: requireString(input, 'id'),
        sourceClass: requireString(input, 'sourceClass') as Parameters<SkillLifecycleService['prepareInstall']>[0]['sourceClass'],
        source: requireString(input, 'source'),
        risk: requireString(input, 'risk') as Parameters<SkillLifecycleService['prepareInstall']>[0]['risk'],
        changeKind: requireString(input, 'changeKind') as Parameters<SkillLifecycleService['prepareInstall']>[0]['changeKind'],
        actor: requireActor(input),
      });
    case 'confirm-install':
      return await service.confirmInstall(requireString(input, 'nonce'), requireActor(input));
    case 'enable':
      return await service.setEnabled(requireString(input, 'id'), true, requireActor(input));
    case 'disable':
      return await service.setEnabled(requireString(input, 'id'), false, requireActor(input));
    case 'rollback':
      return await service.rollback(requireString(input, 'id'), requireActor(input));
    default:
      throw new Error(`未知 Skill lifecycle 命令：${command}`);
  }
}

export function createDefaultSkillLifecycleService(): SkillLifecycleService {
  return createSkillLifecycleService({
    registry: createSkillRegistry(),
    tools: createOfficialSkillTools(),
  });
}

async function main(): Promise<void> {
  const result = await executeSkillLifecycleCommand(process.argv.slice(2), createDefaultSkillLifecycleService());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath && path.resolve(fileURLToPath(import.meta.url)) === entryPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
