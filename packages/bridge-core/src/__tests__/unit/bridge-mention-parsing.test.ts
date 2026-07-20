import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractExplicitFeishuMentionTargetsFromRequest,
  isFeishuMentionExecutionRequest,
  normalizeFeishuMentionTargetKey,
  parseEnvelopeMentions,
  readFeishuMentionIds,
  stripFeishuGenericBareMentionText,
  stripFeishuPlaceholderMentionText,
} from '../../lib/bridge/application/mentions.js';

describe('bridge mention parsing', () => {
  it('normalizes supported Feishu id fields without accepting placeholders', () => {
    assert.deepEqual(readFeishuMentionIds({
      user_id: 'ou_user',
      openId: 'ou_open',
      union_id: 'on_union',
    }), ['ou_user', 'ou_open', 'on_union']);

    assert.deepEqual(parseEnvelopeMentions([
      { open_id: 'ou_target', user_name: '乔治' },
      { userId: '_user_1', name: '占位符' },
      { at_all: true, name: '所有人' },
    ]), [
      { userId: 'ou_target', name: '乔治' },
      { name: '所有人', atAll: true },
    ]);
  });

  it('extracts explicit named targets from direct commands', () => {
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('请艾特乔治，让他看一下'), ['乔治']);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('麻烦艾特大虾米一下'), ['大虾米']);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('让 George 说话'), ['George']);
  });

  it('keeps workflow narration and delivery diagnostics out of execution intent', () => {
    assert.equal(isFeishuMentionExecutionRequest('之后主持人艾特另一个参与者继续'), false);
    assert.equal(isFeishuMentionExecutionRequest('为什么群里的 @ 通知没有送进来'), false);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('等待主持人艾特参与者后再回答'), []);
  });

  it('uses a supplied wake alias only as an invocation prefix', () => {
    const options = { invocationAliases: ['小虾米'] };
    assert.equal(isFeishuMentionExecutionRequest('小虾米，艾特乔治', options), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('小虾米，艾特乔治', options), ['乔治']);
    assert.equal(normalizeFeishuMentionTargetKey('@小虾米'), '小虾米');
  });

  it('removes placeholder and non-addressable at markers while preserving text meaning', () => {
    assert.equal(stripFeishuPlaceholderMentionText('请 @_user_1 看一下'), '请 看一下');
    assert.equal(stripFeishuGenericBareMentionText('请 @你的主人 看一下'), '请 你的主人 看一下');
    assert.equal(stripFeishuGenericBareMentionText('请 @乔治 看一下'), '请 @乔治 看一下');
  });
});
