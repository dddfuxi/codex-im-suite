import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createOfficialSkillTools, type ProcessCall } from '../official-skill-tools.js';

describe('official skill tools', () => {
  it('uses official creator and validator scripts without shell interpolation', async () => {
    const calls: ProcessCall[] = [];
    const codexHome = path.resolve('C:/test/codex-home');
    const draftRoot = path.resolve('C:/test/drafts');
    const tools = createOfficialSkillTools({
      codexHome,
      pythonExe: 'python',
      run: async (call) => {
        calls.push(call);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });

    await tools.createDraft({
      name: 'asset-cleaner',
      draftRoot,
      displayName: 'Asset Cleaner',
      description: 'Clean assets',
      defaultPrompt: 'Clean this asset',
    });
    await tools.validate(path.join(draftRoot, 'asset-cleaner'));

    const initSkillScript = path.join(codexHome, 'skills', '.system', 'skill-creator', 'scripts', 'init_skill.py');
    const quickValidateScript = path.join(codexHome, 'skills', '.system', 'skill-creator', 'scripts', 'quick_validate.py');
    assert.equal(calls[0].file, 'python');
    assert.deepEqual(calls[0].args.slice(0, 4), [initSkillScript, 'asset-cleaner', '--path', draftRoot]);
    assert.equal(calls[0].shell, false);
    assert.equal(calls[0].env?.CODEX_HOME, codexHome);
    assert.equal(calls[0].env?.PYTHONUTF8, '1');
    assert.equal(calls[0].env?.PYTHONIOENCODING, 'utf-8');
    assert.equal(calls[0].args.includes('--interface'), true);
    assert.deepEqual(calls[1].args, [quickValidateScript, path.join(draftRoot, 'asset-cleaner')]);
    assert.equal(calls[1].shell, false);
  });

  it('uses the official curated list and GitHub installer scripts', async () => {
    const calls: ProcessCall[] = [];
    const codexHome = path.resolve('C:/test/codex-home');
    const tools = createOfficialSkillTools({
      codexHome,
      pythonExe: 'python',
      run: async (call) => {
        calls.push(call);
        return call.args.some((arg) => arg.endsWith('list-skills.py'))
          ? { exitCode: 0, stdout: JSON.stringify([{ name: 'doc-helper', installed: false }]), stderr: '' }
          : { exitCode: 0, stdout: 'installed', stderr: '' };
      },
    });

    const listed = await tools.listCurated();
    await tools.installFromGithub({
      url: 'https://github.com/openai/skills/tree/main/skills/.curated/doc-helper',
      destinationRoot: path.resolve('C:/test/staging'),
      name: 'doc-helper',
    });

    assert.deepEqual(listed, [{ name: 'doc-helper', installed: false }]);
    assert.deepEqual(calls[0].args.slice(-2), ['--format', 'json']);
    assert.deepEqual(calls[1].args.slice(-6), [
      '--url',
      'https://github.com/openai/skills/tree/main/skills/.curated/doc-helper',
      '--dest',
      path.resolve('C:/test/staging'),
      '--name',
      'doc-helper',
    ]);
  });
});
