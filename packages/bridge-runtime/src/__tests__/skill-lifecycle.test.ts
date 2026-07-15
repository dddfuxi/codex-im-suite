import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillRegistry } from '../skill-registry.js';
import { createSkillLifecycleService, type SkillLifecycleToolset } from '../skill-lifecycle.js';

const actor = { channelType: 'feishu', chatId: 'oc_test', userId: 'ou_test' };
const fixedNow = new Date('2026-07-15T03:00:00.000Z');

function writeSkill(root: string, id: string, body: string): void {
  const skillDir = path.join(root, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${id}\ndescription: test\n---\n\n${body}\n`, 'utf8');
}

function fixture(): { root: string; ctiHome: string; codexHome: string; suiteRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-skill-lifecycle-'));
  const ctiHome = path.join(root, 'cti-home');
  const codexHome = path.join(root, 'codex-home');
  const suiteRoot = path.join(root, 'suite');
  fs.mkdirSync(path.join(codexHome, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(suiteRoot, 'config', 'skills.d'), { recursive: true });
  return { root, ctiHome, codexHome, suiteRoot };
}

function fakeTools(options: { failValidation?: boolean } = {}): SkillLifecycleToolset {
  return {
    createDraft: async () => undefined,
    validate: async (skillDir) => ({ ok: !options.failValidation, summary: options.failValidation ? 'invalid' : `valid:${skillDir}` }),
    listCurated: async () => [],
    installFromGithub: async ({ destinationRoot, name }) => {
      writeSkill(destinationRoot, name, 'new version');
    },
  };
}

describe('SkillLifecycleService', () => {
  it('does not search the official catalog when an installed skill already matches', async () => {
    const paths = fixture();
    let curatedCalls = 0;
    try {
      writeSkill(path.join(paths.codexHome, 'skills'), 'asset-cleaner', 'installed capability');
      const tools = fakeTools();
      tools.listCurated = async () => {
        curatedCalls += 1;
        return [{ name: 'asset-cleaner-pro', installed: false }];
      };
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools,
        now: () => fixedNow,
      });

      const results = await service.search('asset-cleaner');

      assert.equal(curatedCalls, 0);
      assert.deepEqual(results.map((item) => item.id), ['asset-cleaner']);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('searches the official catalog when no installed skill matches', async () => {
    const paths = fixture();
    let curatedCalls = 0;
    try {
      const tools = fakeTools();
      tools.listCurated = async () => {
        curatedCalls += 1;
        return [{ name: 'asset-cleaner', installed: false }];
      };
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools,
        now: () => fixedNow,
      });

      const results = await service.search('asset-cleaner');

      assert.equal(curatedCalls, 1);
      assert.deepEqual(results.map((item) => item.id), ['asset-cleaner']);
      assert.equal(results[0]?.sourceClass, 'official_curated');
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('requires user confirmation for an uninstalled official curated skill', async () => {
    const paths = fixture();
    try {
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools: fakeTools(),
        now: () => fixedNow,
        nonceFactory: () => 'nonce-official',
      });

      const result = await service.prepareInstall({
        id: 'doc-helper',
        sourceClass: 'official_curated',
        source: 'https://github.com/openai/skills/tree/main/skills/.curated/doc-helper',
        risk: 'low',
        changeKind: 'install',
        actor,
      });

      assert.equal('nonce' in result, true);
      assert.equal('nonce' in result ? result.requiredRole : '', 'user');
      assert.equal(fs.existsSync(path.join(paths.codexHome, 'skills', 'doc-helper')), false);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('automatically installs a low-risk whitelisted skill', async () => {
    const paths = fixture();
    try {
      const source = 'https://github.com/example/skills/tree/main/safe-skill';
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools: fakeTools(),
        now: () => fixedNow,
        whitelistedSources: [source],
      });

      const result = await service.prepareInstall({
        id: 'safe-skill',
        sourceClass: 'whitelist',
        source,
        risk: 'low',
        changeKind: 'install',
        actor,
      });

      assert.equal('nonce' in result, false);
      assert.equal('state' in result ? result.state : '', 'enabled');
      assert.equal(fs.existsSync(path.join(paths.codexHome, 'skills', 'safe-skill', 'SKILL.md')), true);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('does not trust a caller that labels an unknown GitHub source as whitelisted', async () => {
    const paths = fixture();
    try {
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools: fakeTools(),
        now: () => fixedNow,
        nonceFactory: () => 'nonce-forged-whitelist',
      });

      const result = await service.prepareInstall({
        id: 'forged-safe-skill',
        sourceClass: 'whitelist',
        source: 'https://github.com/unknown/skills/tree/main/forged-safe-skill',
        risk: 'low',
        changeKind: 'install',
        actor,
      });

      assert.equal('nonce' in result ? result.requiredRole : '', 'owner');
      assert.equal(fs.existsSync(path.join(paths.codexHome, 'skills', 'forged-safe-skill')), false);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('installs an exact local source declared by the suite skill manifest', async () => {
    const paths = fixture();
    try {
      const source = path.join(paths.suiteRoot, 'extensions', 'skills', 'bundled-skill');
      writeSkill(path.dirname(source), 'bundled-skill', 'bundled version');
      fs.writeFileSync(path.join(paths.suiteRoot, 'config', 'skills.d', 'bundled-skill.json'), JSON.stringify({
        id: 'bundled-skill',
        displayName: 'Bundled Skill',
        type: 'skill',
        source,
        enabled: true,
      }), 'utf8');
      const registry = createSkillRegistry({ ...paths, now: () => fixedNow });
      registry.refresh();
      const service = createSkillLifecycleService({ ...paths, registry, tools: fakeTools(), now: () => fixedNow });

      const installed = await service.prepareInstall({
        id: 'bundled-skill',
        sourceClass: 'whitelist',
        source,
        risk: 'low',
        changeKind: 'install',
        actor,
      });

      assert.equal('state' in installed ? installed.state : '', 'enabled');
      assert.match(fs.readFileSync(path.join(paths.codexHome, 'skills', 'bundled-skill', 'SKILL.md'), 'utf8'), /bundled version/u);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('installs a validated self-created draft only after user confirmation', async () => {
    const paths = fixture();
    try {
      const registry = createSkillRegistry({ ...paths, now: () => fixedNow });
      writeSkill(registry.draftRoot, 'self-skill', 'draft version');
      registry.refresh();
      const service = createSkillLifecycleService({
        ...paths,
        registry,
        tools: fakeTools(),
        now: () => fixedNow,
        nonceFactory: () => 'nonce-self-created',
      });

      const prepared = await service.prepareInstall({
        id: 'self-skill',
        sourceClass: 'self_created',
        source: path.join(registry.draftRoot, 'self-skill'),
        risk: 'low',
        changeKind: 'install',
        actor,
      });
      assert.equal('nonce' in prepared ? prepared.requiredRole : '', 'user');

      const installed = await service.confirmInstall('nonce-self-created', actor);
      assert.equal(installed.state, 'enabled');
      assert.match(fs.readFileSync(path.join(paths.codexHome, 'skills', 'self-skill', 'SKILL.md'), 'utf8'), /draft version/u);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('requires owner confirmation for a third-party source', async () => {
    const paths = fixture();
    try {
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools: fakeTools(),
        now: () => fixedNow,
        nonceFactory: () => 'nonce-third-party',
      });

      const result = await service.prepareInstall({
        id: 'unknown-skill',
        sourceClass: 'third_party',
        source: 'https://github.com/example/skills/tree/main/unknown-skill',
        risk: 'medium',
        changeKind: 'install',
        actor,
      });

      assert.equal('nonce' in result ? result.requiredRole : '', 'owner');
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('marks an installed skill approval as pending when its trigger changes', async () => {
    const paths = fixture();
    try {
      writeSkill(path.join(paths.codexHome, 'skills'), 'trigger-skill', 'stable version');
      const registry = createSkillRegistry({ ...paths, now: () => fixedNow });
      registry.refresh();
      const source = 'https://github.com/example/skills/tree/main/trigger-skill';
      const service = createSkillLifecycleService({
        ...paths,
        registry,
        tools: fakeTools(),
        now: () => fixedNow,
        nonceFactory: () => 'nonce-trigger',
        whitelistedSources: [source],
      });

      await service.prepareInstall({
        id: 'trigger-skill',
        sourceClass: 'whitelist',
        source,
        risk: 'low',
        changeKind: 'trigger',
        actor,
      });

      const pending = registry.read().items.find((item) => item.id === 'trigger-skill');
      assert.equal(pending?.state, 'approval_pending');
      assert.equal(pending?.approval?.required, 'user');
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('keeps the installed version unchanged when validation fails', async () => {
    const paths = fixture();
    try {
      writeSkill(path.join(paths.codexHome, 'skills'), 'stable-skill', 'stable version');
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools: fakeTools({ failValidation: true }),
        now: () => fixedNow,
      });

      await assert.rejects(() => service.prepareInstall({
        id: 'stable-skill',
        sourceClass: 'whitelist',
        source: 'https://github.com/example/skills/tree/main/stable-skill',
        risk: 'low',
        changeKind: 'compatibility',
        actor,
      }), /invalid/u);

      assert.match(fs.readFileSync(path.join(paths.codexHome, 'skills', 'stable-skill', 'SKILL.md'), 'utf8'), /stable version/u);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('redacts secrets from failed lifecycle audit records', async () => {
    const paths = fixture();
    try {
      const tools = fakeTools({ failValidation: true });
      tools.validate = async () => ({ ok: false, summary: 'token=secret-value validation failed' });
      const source = 'https://github.com/example/skills/tree/main/audit-skill';
      const service = createSkillLifecycleService({
        ...paths,
        registry: createSkillRegistry({ ...paths, now: () => fixedNow }),
        tools,
        now: () => fixedNow,
        whitelistedSources: [source],
      });

      await assert.rejects(() => service.prepareInstall({
        id: 'audit-skill',
        sourceClass: 'whitelist',
        source,
        risk: 'low',
        changeKind: 'install',
        actor,
      }));

      const audit = fs.readFileSync(path.join(paths.ctiHome, 'data', 'skill-lifecycle-audit.jsonl'), 'utf8');
      assert.doesNotMatch(audit, /secret-value/u);
      assert.match(audit, /REDACTED/u);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });
});
