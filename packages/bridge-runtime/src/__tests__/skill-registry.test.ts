import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillRegistry } from '../skill-registry.js';

const fixedNow = new Date('2026-07-15T02:00:00.000Z');

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeSkill(skillRoot: string, id: string, body = '原始正文'): string {
  const skillDir = path.join(skillRoot, id);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, `---\nname: ${id}\ndescription: ${id} description\n---\n\n${body}\n`, 'utf8');
  return skillPath;
}

function createFixture(): { root: string; ctiHome: string; codexHome: string; suiteRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-skill-registry-'));
  const ctiHome = path.join(root, 'cti-home');
  const codexHome = path.join(root, 'codex-home');
  const suiteRoot = path.join(root, 'suite');
  fs.mkdirSync(path.join(codexHome, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(ctiHome, 'extensions', 'drafts', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(suiteRoot, 'config', 'skills.d'), { recursive: true });
  return { root, ctiHome, codexHome, suiteRoot };
}

describe('SkillRegistry', () => {
  it('merges manifests, installed skills and drafts without rewriting SKILL.md', () => {
    const fixture = createFixture();
    try {
      writeJson(path.join(fixture.suiteRoot, 'config', 'skills.d', 'catalog-only.json'), {
        id: 'catalog-only',
        displayName: 'Catalog Only',
        type: 'skill',
        version: '1.0.0',
        enabled: true,
      });
      writeJson(path.join(fixture.suiteRoot, 'config', 'skills.d', 'installed-skill.json'), {
        id: 'installed-skill',
        displayName: 'Manifest Name',
        type: 'skill',
        enabled: true,
      });
      const installedSkillPath = writeSkill(path.join(fixture.codexHome, 'skills'), 'installed-skill');
      writeSkill(path.join(fixture.ctiHome, 'extensions', 'drafts', 'skills'), 'draft-skill');
      const installedSkillBefore = fs.readFileSync(installedSkillPath, 'utf8');

      const registry = createSkillRegistry({ ...fixture, now: () => fixedNow });
      const snapshot = registry.refresh();

      assert.equal(snapshot.protocol, 'cti-skill-registry/v1');
      assert.equal(snapshot.items.find((item) => item.id === 'installed-skill')?.state, 'enabled');
      assert.equal(snapshot.items.find((item) => item.id === 'draft-skill')?.state, 'draft');
      assert.equal(snapshot.items.find((item) => item.id === 'catalog-only')?.state, 'discovered');
      assert.equal(snapshot.items.filter((item) => item.id === 'installed-skill').length, 1);
      assert.equal(fs.readFileSync(installedSkillPath, 'utf8'), installedSkillBefore);
      assert.equal(snapshot.items.every((item) => !item.path || path.isAbsolute(item.path)), true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('restores the last valid snapshot from backup when the registry is corrupted', () => {
    const fixture = createFixture();
    try {
      writeSkill(path.join(fixture.codexHome, 'skills'), 'stable-skill');
      const registry = createSkillRegistry({ ...fixture, now: () => fixedNow });
      registry.refresh();
      registry.refresh();
      fs.writeFileSync(path.join(fixture.ctiHome, 'data', 'skill-registry.json'), '{broken', 'utf8');

      const recovered = registry.read();

      assert.equal(recovered.items.some((item) => item.id === 'stable-skill'), true);
      assert.equal(recovered.protocol, 'cti-skill-registry/v1');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('prefers installed skill metadata over drafts and manifests with the same id', () => {
    const fixture = createFixture();
    try {
      writeJson(path.join(fixture.suiteRoot, 'config', 'skills.d', 'shared.json'), {
        id: 'shared',
        displayName: 'Manifest Shared',
        type: 'skill',
        enabled: true,
      });
      writeSkill(path.join(fixture.ctiHome, 'extensions', 'drafts', 'skills'), 'shared', 'draft');
      const installedPath = writeSkill(path.join(fixture.codexHome, 'skills'), 'shared', 'installed');

      const item = createSkillRegistry({ ...fixture, now: () => fixedNow }).refresh().items.find((candidate) => candidate.id === 'shared');

      assert.equal(item?.state, 'enabled');
      assert.equal(item?.path, path.resolve(path.dirname(installedPath)));
      assert.equal(item?.sourceClass, 'installed');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
