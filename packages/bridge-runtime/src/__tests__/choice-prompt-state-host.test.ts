import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeChoicePromptStateHost } from '../choice-prompt-state-host.js';

test('choice prompt state host persists UTF-8 state and rejects malformed snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-choice-state-'));
  try {
    const host = new RuntimeChoicePromptStateHost(root);
    const now = Date.now();
    host.writeSnapshot({
      protocol: 'cti-choice-prompts/v1',
      updatedAt: new Date(now).toISOString(),
      entries: [{
        nonce: 'nonce_12345678',
        channelType: 'feishu',
        chatId: 'oc_chat',
        userId: 'ou_owner',
        sessionId: 'session_1',
        prompt: '请选择下一步。',
        options: [{ label: '继续探索' }, { label: '暂时休息', description: '恢复状态' }],
        flowId: 'flow_12345678',
        flowMode: 'continuous',
        continuationGroupMode: 'parallel',
        continuationParticipantKey: 'branch_12345678',
        expiresAt: now + 60_000,
      }],
      consumed: [],
    });

    const restored = host.readSnapshot();
    assert.equal(restored?.entries[0].prompt, '请选择下一步。');
    assert.equal(restored?.entries[0].flowId, 'flow_12345678');
    assert.equal(restored?.entries[0].continuationGroupMode, 'parallel');
    assert.equal(restored?.entries[0].continuationParticipantKey, 'branch_12345678');
    assert.equal(fs.readFileSync(host.statePath, 'utf8').includes('继续探索'), true);

    fs.writeFileSync(host.statePath, JSON.stringify({
      ...restored,
      entries: [
        ...(restored?.entries || []),
        { ...(restored?.entries[0] || {}), nonce: 'expired_12345678', expiresAt: now - 1 },
      ],
    }), 'utf8');
    assert.equal(host.readSnapshot()?.entries.length, 1);

    fs.writeFileSync(host.statePath, JSON.stringify({
      protocol: 'cti-choice-prompts/v1',
      updatedAt: new Date().toISOString(),
      entries: [{ nonce: '../bad', expiresAt: now + 60_000, options: [] }],
      consumed: [],
    }), 'utf8');
    assert.equal(host.readSnapshot(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('choice prompt state host restores vote selections, deadlines and pending finalization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-group-choice-state-'));
  try {
    const host = new RuntimeChoicePromptStateHost(root);
    const now = Date.now();
    host.writeSnapshot({
      protocol: 'cti-choice-prompts/v2',
      updatedAt: new Date(now).toISOString(),
      entries: [{
        nonce: 'vote_nonce_1234',
        channelType: 'feishu',
        chatId: 'oc_chat',
        userId: 'ou_host',
        sessionId: 'session_1',
        prompt: '全员选路线。',
        options: [{ label: '左路' }, { label: '右路' }],
        choiceSession: {
          mode: 'vote', audience: 'chat_members', state: 'active', durationSeconds: 30, allowChange: true,
        },
        openedAt: now,
        closesAt: now + 30_000,
        expiresAt: now + 150_000,
        selections: [{ participantKey: 'ou_a', optionIndex: 1, selectedAt: now + 1_000 }],
        eligibleParticipantKeys: ['ou_a', 'ou_b'],
        cardMessageId: 'om_card',
        cardHero: { imageKey: 'img_scene', alt: '遗迹入口' },
      }],
      consumed: [],
      finalizations: [{
        nonce: 'finished_vote_1',
        channelType: 'feishu',
        chatId: 'oc_old',
        userId: 'ou_host',
        sessionId: 'session_old',
        choiceMode: 'vote',
        prompt: '旧投票',
        participantCount: 2,
        eligibleParticipantCount: 2,
        tally: [{ label: 'A', count: 2 }, { label: 'B', count: 0 }],
        winningOptions: [{ label: 'A', count: 2 }],
        finalizationReason: 'all_participants_selected',
        finalizedAt: now,
      }],
    });

    const restored = host.readSnapshot();
    assert.equal(restored?.protocol, 'cti-choice-prompts/v2');
    assert.equal(restored?.entries[0].choiceSession?.mode, 'vote');
    assert.equal(restored?.entries[0].selections?.[0].optionIndex, 1);
    assert.deepEqual(restored?.entries[0].eligibleParticipantKeys, ['ou_a', 'ou_b']);
    assert.equal(restored?.entries[0].cardHero?.imageKey, 'img_scene');
    assert.equal(restored?.finalizations?.[0].winningOptions[0].label, 'A');
    assert.equal(restored?.finalizations?.[0].finalizationReason, 'all_participants_selected');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
