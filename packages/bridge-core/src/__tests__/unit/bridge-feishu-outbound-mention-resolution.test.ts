import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeishuMentionCandidate } from '../../lib/bridge/channels/feishu/mentions/outbound-mention-resolution.js';

async function loadMentionResolution() {
  return await import('../../lib/bridge/channels/feishu/mentions/outbound-mention-resolution.js');
}

describe('Feishu outbound mention resolution', () => {
  it('normalizes member payload variants while rejecting app and bot identifiers', async () => {
    const {
      buildFeishuMentionCandidateFromMember,
      pickFeishuMentionableMemberId,
    } = await loadMentionResolution();

    const candidate = buildFeishuMentionCandidateFromMember({
      id: { open_id: 'ou_user' },
      display_name: '张 三',
      en_name: 'Alice Zhang',
      i18n_name: { zh_cn: '张三', en_us: 'Alice' },
    });

    assert.equal(candidate?.userId, 'ou_user');
    assert.equal(candidate?.name, '张 三');
    assert.deepEqual(candidate?.aliases, ['张 三', 'Alice Zhang', 'Alice']);
    assert.equal(buildFeishuMentionCandidateFromMember({ app_id: 'cli_app', app_name: '机器人' }), null);
    assert.equal(pickFeishuMentionableMemberId({ member_id: 'ou_legacy' }, false), 'ou_legacy');
    assert.equal(pickFeishuMentionableMemberId({ member_id: 'legacy_user' }, false), '');
    assert.equal(pickFeishuMentionableMemberId({ member_id: 'legacy_user' }, true), 'legacy_user');
  });

  it('merges aliases and evidence sources by stable user id', async () => {
    const {
      addFeishuMentionCandidate,
    } = await loadMentionResolution();
    const candidates = new Map();

    addFeishuMentionCandidate(candidates, {
      userId: 'ou_user',
      name: '张三',
      aliases: ['Alice'],
      evidenceSource: 'history',
    });
    addFeishuMentionCandidate(candidates, {
      userId: 'ou_user',
      name: '张三同学',
      aliases: ['张 三'],
      evidenceSource: 'current_chat',
    });
    addFeishuMentionCandidate(candidates, {
      userId: 'cli_bot',
      name: '机器人',
      evidenceSource: 'current_chat',
    });

    assert.deepEqual([...candidates.values()], [{
      userId: 'ou_user',
      name: '张三',
      aliases: ['张三', 'Alice', '张三同学'],
      evidenceSources: ['history', 'current_chat'],
    }]);
  });

  it('prefers current platform evidence over stale history but keeps equal-rank matches ambiguous', async () => {
    const {
      resolveFeishuOutboundMentionTarget,
    } = await loadMentionResolution();
    const candidates: FeishuMentionCandidate[] = [
      { userId: 'ou_old', name: '乔治', aliases: ['乔治'], evidenceSources: ['history'] },
      { userId: 'ou_live', name: '乔治机器人', aliases: ['乔治'], evidenceSources: ['current_chat'] },
    ];

    assert.deepEqual(resolveFeishuOutboundMentionTarget('乔治', candidates), {
      userId: 'ou_live',
      name: '乔治机器人',
    });
    assert.deepEqual(resolveFeishuOutboundMentionTarget('所有人', candidates), {
      atAll: true,
      name: '所有人',
    });
    assert.equal(resolveFeishuOutboundMentionTarget('乔治', [
      ...candidates,
      { userId: 'ou_live_2', name: '另一个乔治', aliases: ['乔治'], evidenceSources: ['current_chat'] },
    ]), null);
  });

  it('uniquely resolves a bot sender from app or platform ids and rejects identity conflicts', async () => {
    const {
      resolveFeishuBotSenderMentionCandidate,
    } = await loadMentionResolution();
    const candidates: FeishuMentionCandidate[] = [
      {
        userId: 'ou_george',
        name: '乔治',
        aliases: ['乔治'],
        appIds: ['cli_george'],
        platformIds: ['ou_george', 'on_george'],
        evidenceSources: ['current_chat'],
      },
      {
        userId: 'ou_other',
        name: '另一个机器人',
        aliases: ['另一个机器人'],
        appIds: ['cli_other'],
        evidenceSources: ['current_chat'],
      },
    ];

    assert.equal(resolveFeishuBotSenderMentionCandidate(candidates, {
      appIds: ['cli_george'],
    })?.userId, 'ou_george');
    assert.equal(resolveFeishuBotSenderMentionCandidate(candidates, {
      platformIds: ['ou_george'],
    })?.userId, 'ou_george');
    assert.equal(resolveFeishuBotSenderMentionCandidate(candidates, {
      platformIds: ['on_george'],
    })?.userId, 'ou_george');
    assert.equal(resolveFeishuBotSenderMentionCandidate(candidates, {
      appIds: ['cli_other'],
      platformIds: ['ou_george'],
    }), null);
  });

  it('finds related candidates and emits compact inspection names without ids', async () => {
    const {
      findFeishuMentionCandidateMatches,
      toFeishuMentionResolutionCandidates,
    } = await loadMentionResolution();
    const candidates: FeishuMentionCandidate[] = [
      { userId: 'ou_1', name: '乔治机器人', aliases: ['乔治', 'George'], evidenceSources: ['current_chat'] },
      { userId: 'ou_2', name: '乔治美术', aliases: ['小乔治'], evidenceSources: ['current_chat'] },
    ];

    const related = findFeishuMentionCandidateMatches('乔治', candidates, 'related');
    assert.equal(related.length, 2);
    assert.deepEqual(toFeishuMentionResolutionCandidates(related), [
      { name: '乔治机器人', aliases: ['乔治', 'George'] },
      { name: '乔治美术', aliases: ['小乔治'] },
    ]);
  });

  it('builds deduplicated native tags only from explicit structured mentions', async () => {
    const {
      buildFeishuOutboundMentionTags,
    } = await loadMentionResolution();

    assert.deepEqual(buildFeishuOutboundMentionTags({
      text: '请查看',
      mentions: [
        { userId: 'ou_user', name: '张三' },
        { userId: 'ou_user', name: '重复名字' },
        { atAll: true, name: '所有人' },
      ],
    }), [
      '<at user_id="ou_user">张三</at>',
      '<at user_id="all">所有人</at>',
    ]);
    assert.deepEqual(buildFeishuOutboundMentionTags({
      text: '<at user_id="ou_existing">现有</at> 正文',
      mentions: [{ userId: 'ou_user', name: '张三' }],
    }), []);
  });

  it('extracts verified history mentions and infers direct-message id types', async () => {
    const {
      extractVerifiedFeishuMentionCandidatesFromText,
      inferFeishuDirectMessageReceiveIdType,
    } = await loadMentionResolution();

    assert.deepEqual(extractVerifiedFeishuMentionCandidatesFromText([
      '<at user_id="ou_user">张三</at>',
      '<at id=cli_bot>机器人</at>',
      '<at user_id="all">所有人</at>',
      '<at id=ou_user>张三</at>',
    ].join(' ')), [{ userId: 'ou_user', name: '张三', aliases: ['张三'] }]);
    assert.equal(inferFeishuDirectMessageReceiveIdType('ou_user'), 'open_id');
    assert.equal(inferFeishuDirectMessageReceiveIdType('on_union'), 'union_id');
    assert.equal(inferFeishuDirectMessageReceiveIdType('user_123'), 'user_id');
  });
});
