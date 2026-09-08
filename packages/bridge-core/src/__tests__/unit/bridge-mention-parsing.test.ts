import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractExplicitFeishuMentionTargetsFromRequest,
  hasFeishuCounterpartyMentionHandoff,
  isFeishuGroupAudienceTarget,
  isFeishuMentionExecutionRequest,
  normalizeFeishuMentionTargetKey,
  parseEnvelopeMentionTargets,
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
      id: 'ou_generic',
    }), ['ou_user', 'ou_open', 'on_union', 'ou_generic']);

    assert.deepEqual(parseEnvelopeMentions([
      { open_id: 'ou_target', user_name: '乔治' },
      { userId: '_user_1', name: '占位符' },
      { at_all: true, name: '所有人' },
    ]), [
      { userId: 'ou_target', name: '乔治' },
      { name: '所有人', atAll: true },
    ]);

    assert.deepEqual(parseEnvelopeMentionTargets([
      '乔治',
      { name: '乔治' },
      { user_name: '大虾米' },
      { name: '_user_1' },
    ]), ['乔治', '大虾米']);
  });

  it('extracts explicit named targets from direct commands', () => {
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('请艾特乔治，让他看一下'), ['乔治']);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('麻烦艾特大虾米一下'), ['大虾米']);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('让 George 说话'), ['George']);
    assert.equal(isFeishuMentionExecutionRequest('把她艾特一下'), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('把她艾特一下'), []);
  });

  it('accepts compact latin at commands beside Chinese without matching latin word fragments', () => {
    assert.equal(isFeishuMentionExecutionRequest('你先at乔治啊'), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('你先at乔治啊'), ['乔治']);
    assert.equal(isFeishuMentionExecutionRequest('请ATGeorge'), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('请ATGeorge'), ['George']);
    assert.equal(hasFeishuCounterpartyMentionHandoff('必须at对方'), true);

    for (const text of ['format乔治', 'status乔治', 'chat乔治', 'atmosphere']) {
      assert.equal(isFeishuMentionExecutionRequest(text), false, text);
      assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest(text), [], text);
    }
  });

  it('keeps workflow narration and delivery diagnostics out of execution intent', () => {
    assert.equal(isFeishuMentionExecutionRequest('之后主持人艾特另一个参与者继续'), false);
    assert.equal(isFeishuMentionExecutionRequest('为什么群里的 @ 通知没有送进来'), false);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('等待主持人艾特参与者后再回答'), []);
  });

  it('does not turn reply-continuation text or a group salutation into an outbound mention', () => {
    // 该续办文本由原生 reply 的通用语义恢复器生成，不含任何成员目标。
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('请处理我在本条飞书话题中回复或引用的消息。'), []);
    // 群体称呼只影响要朗读的问候内容，不能要求成员目录解析或阻断语音交付。
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('发语音给群里的大哥大姐打个招呼'), []);
    assert.equal(isFeishuGroupAudienceTarget('群里的大哥大姐'), true);
    assert.equal(isFeishuGroupAudienceTarget('各位飞书机器人'), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('请艾特群里的大哥大姐打个招呼'), []);
    // 保留明确给出具体姓名的同类指令。
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('先发语音，再艾特群里的小明打招呼'), ['小明']);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('向大家问好，再艾特群里的小明'), ['小明']);
  });

  it('treats an explicitly started multi-bot handoff as a current mention action', () => {
    const request = '你们俩开始辩论，乔治先开始，在辩论结束前，每次发表完观点必须 at 对方';
    assert.equal(isFeishuMentionExecutionRequest(request), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest(request), ['乔治']);

    const compactRequest = '你们来开始吵架，必须 at 对方，乔治先开始';
    assert.equal(isFeishuMentionExecutionRequest(compactRequest), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest(compactRequest), ['乔治']);
  });

  it('treats the assigned responder of an immediately started interaction as the current mention target', () => {
    const request = '来一局海龟汤，你出题，乔治回答。每次艾特乔治，并且告诉乔治是或者不是以及回答要艾特你，知道它回答正确后暂停游戏。';
    assert.equal(isFeishuMentionExecutionRequest(request), true);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest(request), ['乔治']);

    assert.equal(isFeishuMentionExecutionRequest('以后每次活动都艾特乔治，今天先不要开始'), false);
    assert.deepEqual(extractExplicitFeishuMentionTargetsFromRequest('以后每次活动都艾特乔治，今天先不要开始'), []);
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
