import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSkillWorkspace, skillAutonomyLabel, type SkillRegistrySnapshot } from './skill-view-model.js';

describe('skill workspace view model', () => {
  it('partitions registry items into installed, drafts, catalog and approvals', () => {
    const snapshot: SkillRegistrySnapshot = {
      protocol: 'cti-skill-registry/v1',
      generatedAt: '2026-07-15T00:00:00.000Z',
      items: [
        item('pending', 'approval_pending', 'third_party', { approval: { required: 'owner', nonce: 'n1', expiresAt: '2026-07-16T00:00:00.000Z' } }),
        item('curated', 'discovered', 'official_curated'),
        item('draft', 'validated', 'self_created'),
        item('installed', 'enabled', 'installed', { enabled: true }),
      ],
    };

    const view = buildSkillWorkspace(snapshot);

    assert.deepEqual(view.installed.map((entry) => entry.id), ['installed']);
    assert.deepEqual(view.drafts.map((entry) => entry.id), ['draft']);
    assert.deepEqual(view.catalog.map((entry) => entry.id), ['curated']);
    assert.deepEqual(view.approvals.map((entry) => entry.id), ['pending']);
  });

  it('uses source and risk instead of skill names for autonomy labels', () => {
    assert.equal(skillAutonomyLabel(item('a', 'discovered', 'official_curated')), '询问后安装');
    assert.equal(skillAutonomyLabel(item('b', 'discovered', 'whitelist')), '可自动处理');
    assert.equal(skillAutonomyLabel(item('c', 'discovered', 'whitelist', { risk: 'high' })), 'Owner 审批');
    assert.equal(skillAutonomyLabel(item('d', 'discovered', 'third_party', { risk: 'medium' })), 'Owner 审批');
  });
});

function item(
  id: string,
  state: SkillRegistrySnapshot['items'][number]['state'],
  sourceClass: SkillRegistrySnapshot['items'][number]['sourceClass'],
  overrides: Partial<SkillRegistrySnapshot['items'][number]> = {},
): SkillRegistrySnapshot['items'][number] {
  return {
    id,
    displayName: id,
    sourceClass,
    state,
    risk: 'low',
    enabled: false,
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}
