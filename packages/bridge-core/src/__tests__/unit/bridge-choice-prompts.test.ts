import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChoicePromptRegistry,
  buildChoiceSessionFinalizationFooter,
  buildChoiceSelectionText,
  buildVoteFinalizationText,
  parseChoiceFlowDirective,
  parseChoicePrompt,
  parseChoiceSessionDirective,
} from '../../lib/bridge/application/choice-prompts.js';
import { prepareDeliveryCandidate } from '../../lib/bridge/application/delivery-preparation.js';
import { buildFeishuChoiceCard } from '../../lib/bridge/channels/feishu/cards/choice-card.js';

describe('structured choice prompts', () => {
  it('accepts only a finite set of visible options from cti-final', () => {
    const choice = parseChoicePrompt([
      { label: '项目 A', description: '只读' },
      { label: '项目 B', description: '读写', callback_data: 'unsafe' },
      { label: '项目 B' },
      { callback_data: 'ignored' },
    ], '选择项目');

    assert.deepEqual(choice, {
      title: '选择项目',
      options: [
        { label: '项目 A', description: '只读' },
        { label: '项目 B', description: '读写' },
      ],
    });
    assert.equal(parseChoicePrompt([{ label: '只有一个' }]), undefined);
  });

  it('parses choices from the final envelope without trusting callback fields', () => {
    const result = prepareDeliveryCandidate([
      '```cti-final',
      JSON.stringify({
        kind: 'text',
        text: '请选择工作模式。',
        images: [],
        files: [],
        reply_mode: 'markdown',
        choice_title: '选择模式',
        choice_session: { mode: 'vote', state: 'active', duration_seconds: 30, callback_url: 'https://unsafe' },
        choices: [
          { label: '安全模式', description: '只读检查', callback_data: 'model:unsafe' },
          { label: '完整模式', description: '允许写入' },
        ],
      }),
      '```',
    ].join('\n'), 'C:\\suite');

    assert.deepEqual(result.payload.choicePrompt, {
      title: '选择模式',
      options: [
        { label: '安全模式', description: '只读检查' },
        { label: '完整模式', description: '允许写入' },
      ],
    });
    assert.deepEqual(result.payload.choiceSession, {
      mode: 'vote', audience: 'chat_members', state: 'active', durationSeconds: 30, allowChange: true,
    });
  });

  it('accepts only the generic continuous choice-flow directive', () => {
    assert.deepEqual(parseChoiceFlowDirective({ mode: 'continuous', state: 'active', flowId: 'model-owned' }), {
      mode: 'continuous',
      state: 'active',
    });
    assert.deepEqual(parseChoiceFlowDirective({ mode: 'continuous', state: 'complete' }), {
      mode: 'continuous',
      state: 'complete',
    });
    assert.equal(parseChoiceFlowDirective({ mode: 'roguelike', state: 'active' }), undefined);
  });

  it('parses only bounded generic group-choice directives', () => {
    assert.deepEqual(parseChoiceSessionDirective({ mode: 'vote', state: 'active', duration_seconds: 30 }), {
      mode: 'vote', audience: 'chat_members', state: 'active', durationSeconds: 30, allowChange: true,
    });
    assert.deepEqual(parseChoiceSessionDirective({ mode: 'claim' }), {
      mode: 'claim', audience: 'chat_members', state: 'active',
    });
    assert.deepEqual(parseChoiceSessionDirective({ mode: 'parallel', callback_url: 'https://unsafe' }), {
      mode: 'parallel', audience: 'chat_members', state: 'active',
    });
    assert.equal(parseChoiceSessionDirective({ mode: 'vote', duration_seconds: 3 }), undefined);
    assert.equal(parseChoiceSessionDirective({ mode: 'vote' }), undefined);
    assert.equal(parseChoiceSessionDirective({ mode: 'permission', duration_seconds: 30 }), undefined);
  });

  it('binds callbacks to the original chat, user and session and consumes them once', () => {
    let now = 1_000;
    const registry = new ChoicePromptRegistry({
      now: () => now,
      ttlMs: 60_000,
      nonceFactory: () => 'nonce_12345678',
    });
    const registered = registry.register({
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_owner',
      sessionId: 'session_1',
      prompt: '请选择工作目录。',
      choicePrompt: {
        title: '选择目录',
        options: [{ label: 'ST4' }, { label: 'Suite', description: '机器人项目' }],
      },
    });

    assert.equal(registered.options[1].callbackData, 'choice:select:nonce_12345678:1');
    assert.equal(registry.consume(registered.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_other',
    }).kind, 'forbidden');
    const selected = registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    });
    assert.equal(selected.kind, 'resolved');
    assert.equal(selected.kind === 'resolved' ? selected.choiceMode : '', 'single_user');
    assert.deepEqual(selected.kind === 'resolved' ? selected.option : null, { label: 'Suite', description: '机器人项目' });
    assert.equal(buildChoiceSelectionText((selected as Extract<typeof selected, { kind: 'resolved' }>).option), '我选择：Suite\n选项说明：机器人项目');
    assert.equal(registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    }).kind, 'consumed');

    const second = registry.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner', sessionId: 'session_1', prompt: '再选一次',
      choicePrompt: { options: [{ label: 'A' }, { label: 'B' }] },
    });
    now += 60_001;
    assert.equal(registry.consume(second.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    }).kind, 'expired');
  });

  it('collects a group vote until deadline and emits one durable aggregate finalization', () => {
    let now = 1_000;
    let snapshot: any = null;
    const registry = new ChoicePromptRegistry({ now: () => now, nonceFactory: () => 'vote_nonce_1234' });
    registry.setStateHost({ readSnapshot: () => snapshot, writeSnapshot: (value) => { snapshot = structuredClone(value); } });
    const registered = registry.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_host', sessionId: 'session_1', prompt: '走哪条路？',
      choicePrompt: { options: [{ label: '左路' }, { label: '右路' }] },
      choiceSession: { mode: 'vote', audience: 'chat_members', state: 'active', durationSeconds: 30, allowChange: true },
    });
    const voteA = registry.consume(registered.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', chatMemberVerified: true,
    });
    assert.equal(voteA.kind, 'recorded');
    const changed = registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', chatMemberVerified: true,
    });
    assert.equal(changed.kind === 'recorded' ? changed.changed : false, true);
    registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_b', chatMemberVerified: true,
    });
    assert.equal(registry.finalizeVote(registered.nonce), null);
    now += 30_000;
    const finalized = registry.finalizeVote(registered.nonce);
    assert.equal(finalized?.participantCount, 2);
    assert.deepEqual(finalized?.tally.map((item) => item.count), [0, 2]);
    assert.equal(registry.listPendingFinalizations().length, 1);
    assert.match(buildVoteFinalizationText(finalized!), /最高票选项：右路/);
    assert.equal(registry.finalizeVote(registered.nonce), null);
    registry.acknowledgeFinalization(registered.nonce);
    assert.equal(registry.listPendingFinalizations().length, 0);
  });

  it('freezes a verified participant roster and finalizes immediately after every member selects', () => {
    let now = 5_000;
    let snapshot: any = null;
    const registry = new ChoicePromptRegistry({ now: () => now, nonceFactory: () => 'complete_vote_1234' });
    registry.setStateHost({ readSnapshot: () => snapshot, writeSnapshot: (value) => { snapshot = structuredClone(value); } });
    const registered = registry.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_host', sessionId: 'session_1', prompt: '全员选门。',
      choicePrompt: { options: [{ label: 'A 门' }, { label: 'B 门' }] },
      choiceSession: { mode: 'vote', audience: 'chat_members', state: 'active', durationSeconds: 60, allowChange: true },
    });

    const first = registry.consume(registered.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', chatMemberVerified: true,
      eligibleParticipantKeys: ['ou_a', 'ou_b'],
    });
    assert.equal(first.kind === 'recorded' ? first.allParticipantsSelected : true, false);
    assert.equal(first.kind === 'recorded' ? first.view.eligibleParticipantCount : 0, 2);
    assert.deepEqual(snapshot.entries[0].eligibleParticipantKeys, ['ou_a', 'ou_b']);
    assert.equal(registry.finalizeVoteIfAllSelected(registered.nonce), null);

    const outsider = registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_c', chatMemberVerified: true,
      eligibleParticipantKeys: ['ou_a', 'ou_b', 'ou_c'],
    });
    assert.equal(outsider.kind, 'forbidden');

    now += 1_000;
    const second = registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_b', chatMemberVerified: true,
      eligibleParticipantKeys: ['ou_a', 'ou_b'],
    });
    assert.equal(second.kind === 'recorded' ? second.allParticipantsSelected : false, true);
    const finalized = registry.finalizeVoteIfAllSelected(registered.nonce);
    assert.equal(finalized?.finalizationReason, 'all_participants_selected');
    assert.equal(finalized?.eligibleParticipantCount, 2);
    assert.match(buildVoteFinalizationText(finalized!), /所有参与成员均已完成选择/u);
    assert.equal(registry.finalizeVoteIfAllSelected(registered.nonce), null);
  });

  it('renders a deterministic winner, tie, or no-vote footer from structured tally state', () => {
    const choiceSession = { mode: 'vote', audience: 'chat_members', state: 'active' } as const;
    assert.equal(buildChoiceSessionFinalizationFooter({
      choiceSession,
      participantCount: 4,
      tally: [{ label: '左路', count: 3 }, { label: '右路', count: 1 }],
    }), '结果：左路（3 票）');
    assert.equal(buildChoiceSessionFinalizationFooter({
      choiceSession,
      participantCount: 6,
      tally: [{ label: '左路', count: 3 }, { label: '右路', count: 3 }],
    }), '平票：左路、右路（各 3 票）');
    assert.equal(buildChoiceSessionFinalizationFooter({
      choiceSession,
      participantCount: 0,
      tally: [{ label: '左路', count: 0 }, { label: '右路', count: 0 }],
    }), '截止时无人参与。');
  });

  it('atomically closes claim and lets each verified participant enter parallel once', () => {
    const claim = new ChoicePromptRegistry({ nonceFactory: () => 'claim_nonce_123' });
    const claimed = claim.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_host', sessionId: 'session_1', prompt: '谁来开门？',
      choicePrompt: { options: [{ label: '开门' }, { label: '侦查' }] },
      choiceSession: { mode: 'claim', audience: 'chat_members', state: 'active' },
    });
    assert.equal(claim.consume(claimed.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', chatMemberVerified: true,
    }).kind, 'resolved');
    assert.equal(claim.consume(claimed.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_b', chatMemberVerified: true,
    }).kind, 'consumed');

    const parallel = new ChoicePromptRegistry({ nonceFactory: () => 'parallel_nonce1' });
    const branched = parallel.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_host', sessionId: 'session_1', prompt: '各走哪条路？',
      choicePrompt: { options: [{ label: '左路' }, { label: '右路' }] },
      choiceSession: { mode: 'parallel', audience: 'chat_members', state: 'active' },
      flow: { mode: 'continuous' },
    });
    assert.equal(parallel.consume(branched.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', chatMemberVerified: true,
    }).kind, 'resolved');
    assert.equal(parallel.consume(branched.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', chatMemberVerified: true,
    }).kind, 'already_participated');
    assert.equal(parallel.consume(branched.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_b', chatMemberVerified: true,
    }).kind, 'resolved');
  });

  it('locks a restored parallel continuation card to its original participant branch', () => {
    let snapshot: any = null;
    let nonceIndex = 0;
    const host = {
      readSnapshot: () => snapshot,
      writeSnapshot: (value: unknown) => { snapshot = structuredClone(value); },
    };
    const registry = new ChoicePromptRegistry({
      nonceFactory: () => `parallel_step_${++nonceIndex}`,
      flowIdFactory: () => 'parallel_flow_1234',
    });
    registry.setStateHost(host);
    const initial = registry.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_host', sessionId: 'session_1', prompt: '各走哪条路？',
      choicePrompt: { options: [{ label: '左路' }, { label: '右路' }] },
      choiceSession: { mode: 'parallel', audience: 'chat_members', state: 'active' },
      flow: { mode: 'continuous' },
    });
    const entered = registry.consume(initial.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', chatMemberVerified: true,
    });
    assert.equal(entered.kind, 'resolved');
    assert.equal(entered.kind === 'resolved' ? entered.continuation?.groupMode : undefined, 'parallel');
    const branchKey = entered.kind === 'resolved' ? entered.continuation?.participantKey : undefined;
    assert.match(branchKey || '', /^[a-f0-9]{12}$/u);

    const followUp = registry.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a', sessionId: 'session_1', prompt: '分线下一步？',
      choicePrompt: { options: [{ label: '搜索' }, { label: '撤退' }] },
      choiceSession: { mode: 'single_user', audience: 'initiator', state: 'active' },
      flow: {
        mode: 'continuous',
        flowId: entered.kind === 'resolved' ? entered.continuation?.flowId : undefined,
        groupMode: 'parallel',
        participantKey: branchKey,
      },
    });
    const persisted = snapshot.entries.find((entry: any) => entry.nonce === followUp.nonce);
    assert.equal(persisted.choiceSession.mode, 'single_user');
    assert.equal(persisted.userId, 'ou_a');
    assert.equal(persisted.continuationGroupMode, 'parallel');
    assert.equal(persisted.continuationParticipantKey, branchKey);

    const restored = new ChoicePromptRegistry();
    restored.setStateHost(host);
    assert.equal(restored.consume(followUp.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_b', chatMemberVerified: true,
    }).kind, 'forbidden');
    const continued = restored.consume(followUp.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_a',
    });
    assert.equal(continued.kind, 'resolved');
    assert.equal(continued.kind === 'resolved' ? continued.continuation?.participantKey : undefined, branchKey);
    assert.equal(continued.kind === 'resolved' ? continued.continuation?.groupMode : undefined, 'parallel');
  });

  it('persists an active flow, restores it after restart and keeps a consumed tombstone', () => {
    let snapshot: any = null;
    const host = {
      readSnapshot: () => snapshot,
      writeSnapshot: (value: unknown) => { snapshot = structuredClone(value); },
    };
    const first = new ChoicePromptRegistry({
      now: () => 10_000,
      nonceFactory: () => 'nonce_flow_1234',
      flowIdFactory: () => 'flow_12345678',
    });
    first.setStateHost(host);
    const registered = first.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner', sessionId: 'session_1', prompt: '继续探索？',
      choicePrompt: { options: [{ label: '前进' }, { label: '休息' }] },
      flow: { mode: 'continuous' },
    });
    assert.equal(registered.flowId, 'flow_12345678');

    const restored = new ChoicePromptRegistry({ now: () => 10_001 });
    restored.setStateHost(host);
    const selected = restored.consume(registered.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    });
    assert.equal(selected.kind, 'resolved');
    assert.deepEqual(selected.kind === 'resolved' ? selected.continuation : undefined, {
      flowId: 'flow_12345678', mode: 'continuous', choicesRequired: true,
    });

    const restartedAgain = new ChoicePromptRegistry({ now: () => 10_002 });
    restartedAgain.setStateHost(host);
    assert.equal(restartedAgain.consume(registered.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    }).kind, 'consumed');
  });

  it('renders workspace and agent choices through one Card 2.0 format', () => {
    const card = JSON.parse(buildFeishuChoiceCard({
      title: '选择工作目录',
      prompt: '请选择一个目录。',
      options: [
        { label: 'ST4', description: 'F:\\unity\\ST4', callbackData: 'workspace:switch:st4' },
        { label: 'Suite', callbackData: 'choice:select:nonce_12345678:1' },
      ],
      cardHero: { imageKey: 'img_v3_scene', alt: '遗迹入口' },
    })) as any;

    assert.equal(card.schema, '2.0');
    assert.equal(card.header.title.content, '选择工作目录');
    assert.deepEqual(card.body.elements[0], {
      tag: 'img',
      img_key: 'img_v3_scene',
      alt: { tag: 'plain_text', content: '遗迹入口' },
      scale_type: 'crop_center',
      margin: '4px -12px',
      preview: true,
    });
    const buttons = card.body.elements.filter((element: any) => element.tag === 'button');
    assert.deepEqual(buttons.map((button: any) => button.value.callback_data), [
      'workspace:switch:st4',
      'choice:select:nonce_12345678:1',
    ]);
  });

  it('renders vote deadline/counts and removes buttons after finalization', () => {
    const active = JSON.parse(buildFeishuChoiceCard({
      title: '全员投票', prompt: '选择路线', choiceMode: 'vote', closesAt: Date.now() + 30_000,
      participantCount: 2,
      eligibleParticipantCount: 3,
      options: [
        { label: '左路', count: 1, callbackData: 'choice:select:vote_nonce_1234:0' },
        { label: '右路', count: 1, callbackData: 'choice:select:vote_nonce_1234:1' },
      ],
    })) as any;
    assert.equal(active.body.elements.filter((item: any) => item.tag === 'button').length, 2);
    assert.match(JSON.stringify(active), /进度/);
    assert.match(JSON.stringify(active), /2 \/ 3 人/u);
    const closed = JSON.parse(buildFeishuChoiceCard({
      title: '全员投票', prompt: '选择路线', choiceMode: 'vote', finalized: true, participantCount: 2,
      options: [
        { label: '左路', count: 1, callbackData: 'unused' },
        { label: '右路', count: 1, callbackData: 'unused' },
      ],
    })) as any;
    assert.equal(closed.body.elements.some((item: any) => item.tag === 'button'), false);
  });
});
