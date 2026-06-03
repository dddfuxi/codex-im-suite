import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideMemoryReply,
  planMemoryQuery,
  shouldDirectAnswerFromMemory,
  shouldRetrieveMemoryForPrompt,
} from '../memory-routing.js';

describe('memory routing', () => {
  it('does not direct-answer ordinary keyword matches from memory', () => {
    assert.equal(shouldDirectAnswerFromMemory('场景名称是什么'), false);
    assert.equal(shouldDirectAnswerFromMemory('HSScene 对应什么'), false);
  });

  it('retrieves memory only for explicit recall or search requests', () => {
    assert.equal(shouldRetrieveMemoryForPrompt('帮我找上次的场景名称对应表'), true);
    assert.equal(shouldRetrieveMemoryForPrompt('你还记得 HSScene 的常用名称吗'), true);
    assert.equal(shouldRetrieveMemoryForPrompt('常用场景名称'), true);
    assert.equal(shouldRetrieveMemoryForPrompt('记忆常用场景名称'), true);
    assert.equal(shouldRetrieveMemoryForPrompt('场景名称是什么'), false);
  });

  it('plans explicit recall by intent instead of a named fast-path key', () => {
    const direct = planMemoryQuery('常用场景名称');
    assert.equal(direct.intent, 'explicit_recall');
    assert.equal(direct.answerMode, 'direct_if_confident');
    assert.equal(direct.allowDirectAnswer, true);
    assert.equal(direct.normalizedKey, '常用场景名称');

    const remembered = planMemoryQuery('我之前记的部署命令是什么');
    assert.equal(remembered.intent, 'explicit_recall');
    assert.equal(remembered.allowDirectAnswer, true);
    assert.equal(remembered.normalizedKey, '部署命令');

    const ordinary = planMemoryQuery('帮我检查 Unity 场景名称是不是写错了');
    assert.equal(ordinary.intent, 'context_augment');
    assert.equal(ordinary.allowDirectAnswer, false);
  });

  it('recognizes explicit memory writes embedded in a sentence', () => {
    const plan = planMemoryQuery('这个是ST横板项目雷霆龙的商城展示界面预制体名称：PreviewDragon_Thunde，请你记一下。路径你也记一下。');
    assert.equal(plan.intent, 'memory_write');
    assert.equal(plan.allowDirectAnswer, false);
  });

  it('treats short named lookup questions with Feishu mentions as explicit recall', () => {
    const plan = planMemoryQuery('第十三条龙叫啥@小虾米');
    assert.equal(plan.intent, 'explicit_recall');
    assert.equal(plan.allowDirectAnswer, true);
    assert.equal(plan.normalizedKey, '第十三条龙');
  });

  it('direct-answers only high-confidence structured memory hits', () => {
    const plan = planMemoryQuery('我之前记的部署命令是什么');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'knowledge-index:deploy',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'summary',
        sourceType: 'knowledge',
        score: 13,
        confidence: 0.92,
        answerability: 'structured',
        quality: 'high',
        structuredKey: '部署命令',
        structuredValue: 'npm run build && npm test',
        content: '部署命令 = npm run build && npm test',
      }],
    });

    assert.equal(decision.type, 'direct_reply');
    assert.match(decision.text || '', /部署命令/);
    assert.match(decision.text || '', /npm run build/);

    const lowValue = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'audit:bad',
        role: 'assistant',
        source: 'message',
        sourceType: 'audit',
        score: 20,
        confidence: 0.95,
        answerability: 'none',
        quality: 'low',
        content: '目前没有可用的部署命令记忆功能。请手动记录。',
      }],
    });
    assert.equal(lowValue.type, 'no_memory_answer');
  });

  it('direct-answers generic named lookup questions from structured knowledge', () => {
    const plan = planMemoryQuery('第十三条龙叫啥@小虾米');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'knowledge-index:dragon',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'summary',
        sourceType: 'knowledge',
        score: 15,
        confidence: 0.93,
        answerability: 'structured',
        quality: 'high',
        structuredKey: '第十三条龙',
        structuredValue: '雷霆龙',
        content: '第十三条龙 = 雷霆龙',
      }],
    });

    assert.equal(decision.type, 'direct_reply');
    assert.match(decision.text || '', /第十三条龙/);
    assert.match(decision.text || '', /雷霆龙/);
  });

  it('does not let unrelated structured transcript snippets direct-answer a named lookup', () => {
    const plan = planMemoryQuery('第十三条龙叫啥@小虾米');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [
        {
          sessionId: 'audit:wrong-table',
          channelType: 'feishu',
          chatId: 'oc_group',
          role: 'assistant',
          source: 'message',
          sourceType: 'audit',
          score: 30,
          confidence: 0.96,
          answerability: 'structured',
          quality: 'high',
          structuredKey: '项目 HSScene',
          structuredValue: '医院内部场景 city3d_citystage_ST2H_Scene == 外城场景',
          content: 'User: 第十三条龙叫啥\nAssistant: 项目 HSScene：医院内部场景 city3d_citystage_ST2H_Scene == 外城场景',
        },
        {
          sessionId: 'knowledge-index:dragon',
          channelType: 'feishu',
          chatId: 'oc_group',
          role: 'assistant',
          source: 'summary',
          sourceType: 'knowledge',
          score: 12,
          confidence: 0.9,
          answerability: 'structured',
          quality: 'high',
          structuredKey: '第十三条龙',
          structuredValue: '雷霆龙',
          content: '第十三条龙 = 雷霆龙',
        },
      ],
    });

    assert.equal(decision.type, 'direct_reply');
    assert.match(decision.text || '', /第十三条龙/);
    assert.match(decision.text || '', /雷霆龙/);
    assert.doesNotMatch(decision.text || '', /HSScene/);
  });

  it('keeps every mapping from a structured memory table when direct-answering', () => {
    const plan = planMemoryQuery('常用场景名称');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'audit:table',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'message',
        sourceType: 'audit',
        score: 18,
        confidence: 0.92,
        answerability: 'structured',
        quality: 'high',
        content: [
          '常用场景名称对应表：',
          '',
          '`HSScene` == 医院内部场景',
          '`city3d_citystage_ST2H_Scene` == 外城场景',
          '`pve_gunship` == pve场景',
          '`Timeline_ST2H_Scene_01` == timeline场景',
        ].join('\n'),
      }],
    });

    assert.equal(decision.type, 'direct_reply');
    const text = decision.type === 'direct_reply' ? decision.text : '';
    assert.match(text, /HSScene.*医院内部场景/s);
    assert.match(text, /city3d_citystage_ST2H_Scene.*外城场景/s);
    assert.match(text, /pve_gunship.*pve场景/s);
    assert.match(text, /Timeline_ST2H_Scene_01.*timeline场景/s);
  });

  it('keeps all structured mappings when the recall intent asks for all items', () => {
    const plan = planMemoryQuery('所有的常用场景名发给我');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'audit:scene-table-all',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'message',
        sourceType: 'audit',
        score: 18,
        confidence: 0.92,
        answerability: 'structured',
        quality: 'high',
        content: [
          '常用场景名称对应表：',
          '',
          '`HSScene` == 医院内部场景',
          '`city3d_citystage_ST2H_Scene` == 外城场景',
          '`pve_gunship` == pve场景',
          '`Timeline_ST2H_Scene_01` == timeline场景',
        ].join('\n'),
      }],
    });

    assert.equal(decision.type, 'direct_reply');
    const text = decision.type === 'direct_reply' ? decision.text : '';
    assert.match(text, /HSScene.*医院内部场景/s);
    assert.match(text, /city3d_citystage_ST2H_Scene.*外城场景/s);
    assert.match(text, /pve_gunship.*pve场景/s);
    assert.match(text, /Timeline_ST2H_Scene_01.*timeline场景/s);
  });

  it('direct-answers a named lookup from a matching structured table value', () => {
    const plan = planMemoryQuery('pve关卡场景叫啥');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'audit:scene-table',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'message',
        sourceType: 'audit',
        score: 18,
        confidence: 0.92,
        answerability: 'structured',
        quality: 'high',
        content: [
          '常用场景名称对应表：',
          '',
          '`HSScene` == 医院内部场景',
          '`city3d_citystage_ST2H_Scene` == 外城场景',
          '`pve_gunship` == pve场景',
          '`Timeline_ST2H_Scene_01` == timeline场景',
        ].join('\n'),
      }],
    });

    assert.equal(decision.type, 'direct_reply');
    const text = decision.type === 'direct_reply' ? decision.text : '';
    assert.match(text, /pve_gunship/);
    assert.match(text, /pve场景/i);
    assert.doesNotMatch(text, /HSScene/);
  });

  it('does not direct-answer a malformed heading-only mapping', () => {
    const plan = planMemoryQuery('常用场景名称');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'audit:bad-heading',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'message',
        sourceType: 'audit',
        score: 30,
        confidence: 0.95,
        answerability: 'structured',
        quality: 'high',
        content: '常用场景名称对应表：HSScene ✅',
      }],
    });

    assert.equal(decision.type, 'augment_codex');
  });

  it('does not direct-answer relation-only memory graph candidates', () => {
    const plan = planMemoryQuery('雷霆龙');
    const decision = decideMemoryReply(plan, {
      summary: 'memory graph related context',
      hits: [{
        sessionId: 'memory-graph:dragon',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'summary',
        sourceType: 'knowledge',
        score: 15,
        confidence: 0.88,
        answerability: 'structured',
        quality: 'medium',
        structuredKey: '雷霆龙',
        structuredValue: '第十三条龙',
        content: '[记忆关系图] 雷霆龙 -> 第十三条龙（reverse_lookup）',
      }],
    });

    assert.equal(decision.type, 'augment_codex');
  });

  it('does not treat URL query parameters as structured memory mappings', () => {
    const plan = planMemoryQuery('常用场景名称');
    const decision = decideMemoryReply(plan, {
      summary: 'memory',
      hits: [{
        sessionId: 'audit:url',
        channelType: 'feishu',
        chatId: 'oc_memory',
        role: 'assistant',
        source: 'message',
        sourceType: 'audit',
        score: 30,
        confidence: 0.95,
        answerability: 'structured',
        quality: 'high',
        content: 'https://funplus.feishu.cn/sheets/ZpW5sfiUohtpFTtg0Yacv5XGnHe?sheet=415299\n看一下并总结这个链接',
      }],
    });

    assert.equal(decision.type, 'augment_codex');
  });
});
