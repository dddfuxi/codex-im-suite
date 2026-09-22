import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createPanelSettingsHost } from '../panel-settings-host.js';

const actor = {
  role: 'owner' as const,
  channelType: 'feishu',
  chatId: 'chat-test',
  userId: 'owner-test',
  messageId: 'message-test',
};

describe('panel settings runtime host', () => {
  it('preserves comments and unknown env fields while returning a redacted current snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-panel-settings-'));
    const configPath = path.join(root, 'config.env');
    const workdir = path.join(root, 'workspace');
    const memory = path.join(root, 'memory');
    fs.writeFileSync(configPath, [
      '# 用户保留的注释',
      'CTI_RUNTIME=codex',
      'CTI_ENABLED_CHANNELS=feishu',
      `CTI_DEFAULT_WORKDIR=${workdir}`,
      `CTI_ALLOWED_WORKSPACE_ROOTS=${workdir}`,
      `CTI_MEMORY_REPO_DIR=${memory}`,
      'CTI_DEFAULT_MODE=code',
      'CTI_CODEX_API_KEY=secret-value-must-not-leak',
      'CTI_UNKNOWN_KEEP_ME=unchanged',
      '',
    ].join('\n'), 'utf8');

    try {
      const host = createPanelSettingsHost({ configPath });
      const before = await host.list({ actor });
      assert.equal(before.protocol, 'cti-panel-settings-snapshot/v1');
      assert.equal(before.settings.find((item) => item.key === 'codexApiKeySet')?.value, true);
      assert.equal(JSON.stringify(before).includes('secret-value-must-not-leak'), false);

      const receipt = await host.update({
        actor,
        expectedVersion: before.version,
        changes: [
          { key: 'replyStyleHint', value: '简洁、结果优先' },
          { key: 'localAiTimeoutMs', value: 60000 },
          { key: 'memoryOptimizerEnabled', value: true },
        ],
      });

      assert.equal(receipt.ok, true);
      assert.equal(receipt.written, true);
      assert.equal(receipt.restartRequired, true);
      assert.equal(receipt.snapshot.settings.find((item) => item.key === 'replyStyleHint')?.value, '简洁、结果优先');
      const content = fs.readFileSync(configPath, 'utf8');
      assert.match(content, /^# 用户保留的注释$/mu);
      assert.match(content, /^CTI_UNKNOWN_KEEP_ME=unchanged$/mu);
      assert.match(content, /^CTI_LOCAL_AI_TIMEOUT_MS=60000$/mu);
      assert.match(content, /^CTI_OLLAMA_TIMEOUT_MS=60000$/mu);
      assert.match(content, /^CTI_MEMORY_OPTIMIZER_ENABLED=true$/mu);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects stale versions, read-only secret fields, invalid paths, and non-owner actors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-panel-settings-'));
    const configPath = path.join(root, 'config.env');
    fs.writeFileSync(configPath, `CTI_RUNTIME=codex\nCTI_ENABLED_CHANNELS=feishu\nCTI_DEFAULT_WORKDIR=${root}\nCTI_DEFAULT_MODE=code\n`, 'utf8');
    try {
      const host = createPanelSettingsHost({ configPath });
      const snapshot = await host.list({ actor });
      await assert.rejects(() => host.update({ actor, expectedVersion: 'stale', changes: [{ key: 'replyStyleHint', value: 'a' }] }), /重新读取/u);
      await assert.rejects(() => host.update({ actor, expectedVersion: snapshot.version, changes: [{ key: 'codexApiKeySet', value: false }] }), /不可通过语音修改/u);
      await assert.rejects(() => host.update({ actor, expectedVersion: snapshot.version, changes: [{ key: 'memoryRepo', value: 'relative' }] }), /绝对路径/u);
      await assert.rejects(() => host.list({ actor: { ...actor, role: 'owner', userId: '' } }), /owner_required/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
