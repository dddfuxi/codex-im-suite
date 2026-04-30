import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readKnowledgeIndex } from '../knowledge-indexer.js';
import { readReminderIndex } from '../todo-reminders.js';
import {
  repairLikelyMojibakeText,
  restoreHistoryMojibakeBackup,
  runHistoryMojibakeRepair,
} from '../history-mojibake-repair.js';

const GB_MOJIBAKE_CHINESE = '\u6d93\ue15f\u6783';

describe('history mojibake repair', () => {
  it('repairs typical UTF-8-as-GBK mojibake without touching clean Chinese', () => {
    const repaired = repairLikelyMojibakeText(`会话: ${GB_MOJIBAKE_CHINESE}需要保留`);

    assert.equal(repaired.changed, true);
    assert.equal(repaired.text, '会话: 中文需要保留');
    assert.equal(repaired.unresolved, false);
  });

  it('scans, applies, rebuilds indexes, and restores from backup manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mojibake-repair-'));
    const ctiHome = path.join(root, 'cti-home');
    const memoryRoot = path.join(root, 'memory');
    const historyDir = path.join(ctiHome, 'data', 'feishu-history');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.mkdirSync(memoryRoot, { recursive: true });
    const historyPath = path.join(historyDir, 'oc_123.json');
    const notePath = path.join(memoryRoot, 'todo.md');
    fs.writeFileSync(historyPath, JSON.stringify([
      {
        messageId: 'om_1',
        chatId: 'oc_123',
        senderName: '刘丹',
        senderId: 'ou_1',
        senderType: 'user',
        msgType: 'text',
        createTime: '1770000000000',
        text: `${GB_MOJIBAKE_CHINESE}历史`,
      },
    ], null, 2), 'utf-8');
    fs.writeFileSync(
      notePath,
      `待办: ${GB_MOJIBAKE_CHINESE}提醒 @2026-04-29 18:30 channelType: feishu chatId: oc_123 状态: 未完成`,
      'utf-8',
    );

    try {
      const scan = runHistoryMojibakeRepair({ ctiHome, memoryRoot, apply: false, generatedAt: '2026-04-30T00:00:00.000Z' });
      assert.equal(scan.mode, 'scan');
      assert.equal(scan.filesWithHits, 2);
      assert.equal(scan.repairedFileCount, 0);
      assert.match(fs.readFileSync(historyPath, 'utf-8'), new RegExp(GB_MOJIBAKE_CHINESE));

      const applied = runHistoryMojibakeRepair({ ctiHome, memoryRoot, apply: true, generatedAt: '2026-04-30T00:00:00.000Z' });
      assert.equal(applied.mode, 'apply');
      assert.equal(applied.repairedFileCount, 2);
      assert.ok(applied.backupManifestPath);
      assert.match(fs.readFileSync(historyPath, 'utf-8'), /中文历史/);
      assert.doesNotMatch(fs.readFileSync(historyPath, 'utf-8'), new RegExp(GB_MOJIBAKE_CHINESE));

      const index = readKnowledgeIndex(memoryRoot);
      assert.equal(index?.itemCount, 1);
      assert.match(index?.items[0].text || '', /中文提醒/);
      assert.doesNotMatch(JSON.stringify(index), new RegExp(GB_MOJIBAKE_CHINESE));

      const reminders = readReminderIndex(memoryRoot);
      assert.equal(reminders?.reminderCount, 1);
      assert.match(reminders?.reminders[0].title || '', /中文提醒/);
      assert.doesNotMatch(JSON.stringify(reminders), new RegExp(GB_MOJIBAKE_CHINESE));

      const restored = restoreHistoryMojibakeBackup(applied.backupManifestPath!);
      assert.equal(restored.restoredFileCount, 2);
      assert.match(fs.readFileSync(historyPath, 'utf-8'), new RegExp(GB_MOJIBAKE_CHINESE));
      assert.match(fs.readFileSync(notePath, 'utf-8'), new RegExp(GB_MOJIBAKE_CHINESE));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
