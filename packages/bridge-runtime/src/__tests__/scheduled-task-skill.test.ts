import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const suiteRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const skillRoot = path.join(suiteRoot, 'extensions', 'skills', 'manage-codex-im-scheduled-tasks');
const skillPath = path.join(skillRoot, 'SKILL.md');
const openAiPath = path.join(skillRoot, 'agents', 'openai.yaml');

describe('Feishu scheduled task skill', () => {
  it('contains every required scheduled-task workflow guard', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    for (const required of [
      'cti-scheduled-task',
      'notify',
      'agent_turn',
      'controlled_tool',
      'Asia/Shanghai',
      '真实飞书',
      '不得声称',
      '只重试投递',
      'Owner',
      '运行账本',
      '执行与投递分离',
      '工作区重新解析',
      '失败关闭',
    ]) {
      assert.match(skill, new RegExp(required));
    }
  });

  it('distinguishes recurring agent work from one-time notifications', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /工作日[^\n]+30 10 \* \* 1-5/u);
    assert.match(skill, /周期[^\n]+cti-scheduled-task/u);
    assert.match(skill, /单次[^\n]+cti-reminder/u);
    assert.match(skill, /法定节假日[^\n]*不/u);
  });

  it('keeps UI metadata aligned with the installed skill name', () => {
    const metadata = fs.readFileSync(openAiPath, 'utf8');
    assert.match(metadata, /display_name: "管理飞书计划任务"/u);
    assert.match(metadata, /short_description: ".{25,64}"/u);
    assert.match(metadata, /default_prompt: "Use \$manage-codex-im-scheduled-tasks/u);
  });
});
