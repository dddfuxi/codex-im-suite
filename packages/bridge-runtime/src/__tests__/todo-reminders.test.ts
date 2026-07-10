import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KnowledgeIndex } from '../knowledge-indexer.js';
import {
  buildReminderIndexFromKnowledge,
  completeReminder,
  createDirectReminder,
  createFeishuPushProvider,
  createWeixinPushProvider,
  evaluateDueReminders,
  readReminderDeliveryState,
  readReminderIndex,
  type ReminderDeliveryState,
  type ReminderPushProvider,
} from '../todo-reminders.js';

function makeIndex(items: KnowledgeIndex['items']): KnowledgeIndex {
  return {
    schema: 'codex-im-suite/knowledge-index/v1',
    memoryRoot: 'E:\\cli-md',
    generatedAt: '2026-04-29T00:00:00.000Z',
    itemCount: items.length,
    conflictCount: 0,
    items,
  };
}

function makeTodo(text: string, snippet = text): KnowledgeIndex['items'][number] {
  return {
    id: `todo-${Math.random().toString(16).slice(2)}`,
    kind: 'todo',
    text,
    confidence: 0.75,
    conflict: false,
    source: {
      path: 'E:\\cli-md\\group-notes.md',
      updatedAt: '2026-04-29T08:00:00.000Z',
      snippet,
    },
  };
}

describe('todo reminders', () => {
  it('derives pending reminders with due time and source chat metadata', () => {
    const index = makeIndex([
      makeTodo(
        '整理主动推送方案 @2026-04-29 18:30 状态: 未完成 channelType: feishu chatId: oc_123 displayName: 项目群',
      ),
    ]);

    const reminderIndex = buildReminderIndexFromKnowledge(index, {
      enabledChannels: ['feishu'],
      generatedAt: '2026-04-29T09:00:00.000Z',
    });

    assert.equal(reminderIndex.schema, 'codex-im-suite/reminders/v1');
    assert.equal(reminderIndex.reminders.length, 1);
    assert.equal(reminderIndex.reminders[0].status, 'pending');
    assert.equal(reminderIndex.reminders[0].dueAt, '2026-04-29T10:30:00.000Z');
    assert.equal(reminderIndex.reminders[0].target.channelType, 'feishu');
    assert.equal(reminderIndex.reminders[0].target.chatId, 'oc_123');
    assert.equal(reminderIndex.reminders[0].target.displayName, '项目群');
  });

  it('uses source metadata when todo text does not repeat chat fields', () => {
    const todo = makeTodo('整理主动推送方案 @2026-04-29 18:30');
    todo.source = {
      ...todo.source,
      metadata: {
        channelType: 'feishu',
        chatId: 'oc_meta',
        displayName: '来源群',
      },
    } as typeof todo.source & { metadata: Record<string, string> };
    const reminderIndex = buildReminderIndexFromKnowledge(makeIndex([todo]), {
      enabledChannels: ['feishu'],
      generatedAt: '2026-04-29T09:00:00.000Z',
    });

    assert.equal(reminderIndex.reminders[0].status, 'pending');
    assert.equal(reminderIndex.reminders[0].target.chatId, 'oc_meta');
    assert.equal(reminderIndex.reminders[0].target.displayName, '来源群');
  });

  it('marks reminders skipped when they lack a due time, source chat, or are completed', () => {
    const index = makeIndex([
      makeTodo('缺少时间 channelType: feishu chatId: oc_123'),
      makeTodo('缺少来源 @2026-04-29 18:30'),
      makeTodo('已完成事项 @2026-04-29 18:30 channelType: feishu chatId: oc_123 状态: 完成'),
    ]);

    const reminderIndex = buildReminderIndexFromKnowledge(index, {
      enabledChannels: ['feishu'],
      generatedAt: '2026-04-29T09:00:00.000Z',
    });

    assert.deepEqual(
      reminderIndex.reminders.map((item) => item.status),
      ['skipped', 'skipped', 'skipped'],
    );
    assert.match(reminderIndex.reminders[0].skipReason || '', /缺少提醒时间/);
    assert.match(reminderIndex.reminders[1].skipReason || '', /缺少来源会话/);
    assert.match(reminderIndex.reminders[2].skipReason || '', /状态为完成/);
  });

  it('only dispatches due pending reminders once', async () => {
    const index = buildReminderIndexFromKnowledge(makeIndex([
      makeTodo('到点提醒 @2026-04-29 18:30 channelType: feishu chatId: oc_123'),
      makeTodo('未来提醒 @2026-04-30 18:30 channelType: feishu chatId: oc_123'),
    ]), {
      enabledChannels: ['feishu'],
      generatedAt: '2026-04-29T09:00:00.000Z',
    });
    const sent: string[] = [];
    const provider: ReminderPushProvider = {
      channelType: 'feishu',
      status: () => ({ channelType: 'feishu', state: 'ok', detail: 'ready' }),
      canSend: () => ({ ok: true }),
      sendReminder: async (reminder) => {
        sent.push(reminder.id);
        return { ok: true, messageId: `msg-${sent.length}` };
      },
    };
    const state: ReminderDeliveryState = {
      schema: 'codex-im-suite/reminder-state/v1',
      updatedAt: '',
      deliveries: {},
    };

    const first = await evaluateDueReminders(index, state, {
      now: '2026-04-29T10:35:00.000Z',
      windowMs: 10 * 60 * 1000,
      providers: [provider],
    });
    const second = await evaluateDueReminders(index, first.state, {
      now: '2026-04-29T10:36:00.000Z',
      windowMs: 10 * 60 * 1000,
      providers: [provider],
    });

    assert.equal(first.results.length, 1);
    assert.equal(first.results[0].ok, true);
    assert.equal(second.results.length, 0);
    assert.equal(sent.length, 1);
  });

  it('reports WeChat push as unsupported for v1', async () => {
    const provider = createWeixinPushProvider();
    const status = provider.status();
    assert.equal(status.state, 'unsupported');

    const canSend = provider.canSend({ channelType: 'weixin', chatId: 'wx_1' });
    assert.equal(canSend.ok, false);
    assert.match(canSend.reason || '', /未接入/);
  });

  it('formats Feishu reminder push through injected delivery function', async () => {
    const reminder = buildReminderIndexFromKnowledge(makeIndex([
      makeTodo('整理主动推送方案 @2026-04-29 18:30 channelType: feishu chatId: oc_123'),
    ]), {
      enabledChannels: ['feishu'],
      generatedAt: '2026-04-29T09:00:00.000Z',
    }).reminders[0];
    const deliveries: Array<{ chatId: string; text: string; dedupKey?: string; feishuCardJson?: string; mentions?: unknown[] }> = [];
    const provider = createFeishuPushProvider({
      enabled: true,
      deliver: async (input) => {
        deliveries.push({
          chatId: input.address.chatId,
          text: input.text,
          dedupKey: input.dedupKey,
          feishuCardJson: input.feishuCardJson,
          mentions: input.mentions,
        });
        return { ok: true, messageId: 'om_1', cardId: 'card_1' };
      },
    });

    const result = await provider.sendReminder(reminder);

    assert.equal(result.ok, true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].chatId, 'oc_123');
    assert.match(deliveries[0].text, /待办提醒/);
    assert.match(deliveries[0].text, /整理主动推送方案/);
    assert.doesNotMatch(deliveries[0].text, /来源：/);
    assert.equal(deliveries[0].dedupKey, `todo-reminder:${reminder.id}`);
    assert.match(deliveries[0].feishuCardJson || '', /reminder:complete:/);
    assert.match(deliveries[0].feishuCardJson || '', new RegExp(reminder.id));
  });

  it('passes structured notify targets to Feishu reminder delivery', async () => {
    const reminder = buildReminderIndexFromKnowledge(makeIndex([
      makeTodo('提交文件 @2026-04-29 18:30 channelType: feishu chatId: oc_123 notifyTargets: ' + encodeURIComponent(JSON.stringify([{ userId: 'ou_liudan', name: '刘丹' }]))),
    ]), {
      enabledChannels: ['feishu'],
      generatedAt: '2026-04-29T09:00:00.000Z',
    }).reminders[0];
    const deliveries: Array<{ mentions?: unknown[]; text: string }> = [];
    const provider = createFeishuPushProvider({
      enabled: true,
      deliver: async (input) => {
        deliveries.push({ mentions: input.mentions, text: input.text });
        return { ok: true, messageId: 'om_1' };
      },
    });

    await provider.sendReminder(reminder);

    assert.deepEqual(deliveries[0].mentions, [{ userId: 'ou_liudan', name: '刘丹' }]);
    assert.match(deliveries[0].text, /提交文件/);
  });

  it('creates direct reminders as markdown-backed pending reminder records', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-direct-reminder-'));
    try {
      const result = createDirectReminder(memoryRoot, {
        title: '看电脑',
        dueAt: '2026-04-29T11:42:00.000Z',
        timezone: 'Asia/Shanghai',
        target: {
          channelType: 'feishu',
          chatId: 'oc_123',
          chatType: 'group',
          displayName: '当前会话',
          messageId: 'om_1',
        },
        notifyTargets: [{ userId: 'ou_liudan', name: '刘丹' }],
        sourcePrompt: '帮我设置个代办，两分钟后给我发消息提醒我看电脑',
        createdAt: '2026-04-29T11:40:00.000Z',
        createdByMessageId: 'om_1',
      });

      assert.equal(result.reminder.status, 'pending');
      assert.equal(result.reminder.sourceType, 'direct');
      assert.equal(result.reminder.createdByMessageId, 'om_1');
      assert.equal(fs.existsSync(result.filePath), true);
      const markdown = fs.readFileSync(result.filePath, 'utf-8');
      assert.match(markdown, /channelType: feishu/);
      assert.match(markdown, /chatId: oc_123/);
      assert.match(markdown, /chatType: group/);
      assert.match(markdown, /notifyTargets:/);
      assert.match(markdown, /createdBy: agent-action/);
      assert.match(markdown, /待办: 看电脑 @2026-04-29 19:42 状态: 未完成/);

      const index = readReminderIndex(memoryRoot);
      assert.equal(index?.reminderCount, 1);
      assert.equal(index?.reminders[0].sourceType, 'direct');
      assert.equal(index?.reminders[0].target.chatType, 'group');
      assert.deepEqual(index?.reminders[0].notifyTargets, [{ userId: 'ou_liudan', name: '刘丹' }]);

      const state = readReminderDeliveryState(memoryRoot);
      assert.equal(state.deliveries[result.reminder.id]?.status, 'pending');
      assert.equal(state.deliveries[result.reminder.id]?.chatType, 'group');
      assert.equal(state.deliveries[result.reminder.id]?.attempts, 0);
    } finally {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
    }
  });

  it('completes direct reminders by updating markdown, index, and delivery state', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-complete-reminder-'));
    try {
      const created = createDirectReminder(memoryRoot, {
        title: '看电脑',
        dueAt: '2026-04-29T11:42:00.000Z',
        timezone: 'Asia/Shanghai',
        target: {
          channelType: 'feishu',
          chatId: 'oc_123',
          displayName: '当前会话',
          messageId: 'om_1',
        },
        sourcePrompt: '两分钟后提醒我看电脑',
        createdAt: '2026-04-29T11:40:00.000Z',
        createdByMessageId: 'om_1',
      });

      const completed = completeReminder(memoryRoot, {
        reminderId: created.reminder.id,
        chatId: 'oc_123',
        completedAt: '2026-04-29T11:43:00.000Z',
        completedByUserId: 'ou_1',
        completionSource: 'panel',
      });

      assert.equal(completed.ok, true);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.sourceUpdated, true);
      const markdown = fs.readFileSync(created.filePath, 'utf-8');
      assert.match(markdown, /状态: 完成/);

      const index = readReminderIndex(memoryRoot);
      assert.equal(index?.reminders[0].todoStatus, 'done');
      const state = readReminderDeliveryState(memoryRoot);
      assert.equal(state.deliveries[created.reminder.id]?.completedAt, '2026-04-29T11:43:00.000Z');
      assert.equal(state.deliveries[created.reminder.id]?.completedByUserId, 'ou_1');
      assert.equal(state.deliveries[created.reminder.id]?.completionSource, 'panel');
    } finally {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
    }
  });
});
