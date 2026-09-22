import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeSkillLifecycleCommand } from '../skill-lifecycle-cli.js';
import type { SkillLifecycleService } from '../skill-lifecycle.js';

const actor = { channelType: 'panel', chatId: 'local', userId: 'owner' };

function encode(value: unknown): string[] {
  return ['--input-base64', Buffer.from(JSON.stringify(value), 'utf8').toString('base64')];
}

describe('skill lifecycle CLI', () => {
  it('routes every command to the shared lifecycle service', async () => {
    const calls: string[] = [];
    const item = {
      id: 'demo-skill',
      displayName: 'Demo Skill',
      sourceClass: 'installed' as const,
      state: 'enabled' as const,
      risk: 'low' as const,
      enabled: true,
      updatedAt: '2026-07-15T04:00:00.000Z',
    };
    const service: SkillLifecycleService = {
      snapshot: () => { calls.push('snapshot'); return { protocol: 'cti-skill-registry/v1', generatedAt: item.updatedAt, items: [item] }; },
      search: async () => { calls.push('search'); return [item]; },
      createDraft: async () => { calls.push('create-draft'); return item; },
      validate: async () => { calls.push('validate'); return item; },
      prepareInstall: async () => { calls.push('prepare-install'); return item; },
      confirmInstall: async () => { calls.push('confirm-install'); return item; },
      setEnabled: async (_id, enabled) => { calls.push(enabled ? 'enable' : 'disable'); return { ...item, enabled, state: enabled ? 'enabled' : 'disabled' }; },
      rollback: async () => { calls.push('rollback'); return item; },
    };

    await executeSkillLifecycleCommand(['snapshot'], service);
    await executeSkillLifecycleCommand(['search', ...encode({ query: 'demo' })], service);
    await executeSkillLifecycleCommand(['create-draft', ...encode({ name: 'demo-skill', displayName: 'Demo', description: 'Demo', defaultPrompt: 'Use demo', actor })], service);
    await executeSkillLifecycleCommand(['validate', ...encode({ id: 'demo-skill' })], service);
    await executeSkillLifecycleCommand(['prepare-install', ...encode({ id: 'demo-skill', sourceClass: 'official_curated', source: 'https://github.com/openai/skills/tree/main/skills/.curated/demo-skill', risk: 'low', changeKind: 'install', actor })], service);
    await executeSkillLifecycleCommand(['confirm-install', ...encode({ nonce: 'nonce', actor })], service);
    await executeSkillLifecycleCommand(['enable', ...encode({ id: 'demo-skill', actor })], service);
    await executeSkillLifecycleCommand(['disable', ...encode({ id: 'demo-skill', actor })], service);
    await executeSkillLifecycleCommand(['rollback', ...encode({ id: 'demo-skill', actor })], service);

    assert.deepEqual(calls, ['snapshot', 'search', 'create-draft', 'validate', 'prepare-install', 'confirm-install', 'enable', 'disable', 'rollback']);
  });

  it('rejects invalid base64 JSON and unknown commands', async () => {
    const service = {} as SkillLifecycleService;
    await assert.rejects(() => executeSkillLifecycleCommand(['search', '--input-base64', '%%%'], service), /输入/u);
    await assert.rejects(() => executeSkillLifecycleCommand(['unknown'], service), /未知/u);
  });
});
