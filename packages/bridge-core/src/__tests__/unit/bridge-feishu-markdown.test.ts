import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFinalCardJson,
  buildStreamingContent,
  extractStreamingFinalResponse,
} from '../../lib/bridge/markdown/feishu.js';
import { buildFeishuCapabilityReport } from '../../lib/bridge/feishu-capabilities.js';

describe('Feishu streaming card markdown', () => {
  it('keeps the user-visible rationale and result sections when finalizing a progress card', () => {
    const text = [
      '# 处理思路',
      '先确认 MCP 服务，再读取可用工具。',
      '',
      '# 执行结果',
      '- 可用工具 12 个。',
    ].join('\n');

    const finalText = extractStreamingFinalResponse(text);
    assert.notEqual(finalText, '- 可用工具 12 个。');
    assert.match(finalText, /^# .+/m);
    assert.match(finalText, /\n\n# .+\n- /);

    const card = JSON.parse(buildFinalCardJson(text, [], null)) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');
    assert.match(content, /^# .+/m);
    assert.match(content, /- .*12/);
  });

  it('preserves rationale headings in the finalized card body when both rationale and result are present', () => {
    const text = [
      '**处理思路**',
      '- 先确认 MCP 服务，再读取可用工具。',
      '',
      '**执行结果**',
      '- 可用工具 12 个。',
    ].join('\n');

    const finalText = extractStreamingFinalResponse(text);
    assert.notEqual(finalText, '- 可用工具 12 个。');
    assert.match(finalText, /^\*\*.+\*\*/m);

    const card = JSON.parse(buildFinalCardJson(text, [], null)) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');
    assert.match(content, /^\*\*.+\*\*/m);
    assert.match(content, /\n\n\*\*.+\*\*\n- /);
  });

  it('reports streaming cards as enabled by default', () => {
    const report = buildFeishuCapabilityReport({
      getSetting: () => '',
    });
    assert.match(report, /Streaming card enabled: yes/);
  });

  it('renders a single polished thinking step with stage accents and a muted body', () => {
    const content = buildStreamingContent('### 处理思路\n正在理解问题。\n正在确认需要截图证据。', [
      { id: 'tool-1', name: 'JsonTool:shell_artifact', status: 'complete' },
      { id: 'tool-2', name: 'JsonTool:mcp_call', status: 'running' },
    ]);

    assert.match(content, /<font color="purple">\*\*确认证据\*\*<\/font>/);
    assert.match(content, /<font color="grey">正在确认需要截图证据。<\/font>/);
    assert.match(content, /依据确认/);
    assert.match(content, /工具完成/);
    assert.match(content, /结果生成/);
    assert.match(content, /正在确认需要截图证据/);
    assert.doesNotMatch(content, /正在理解问题/);
    assert.doesNotMatch(content, /桌面截图/);
    assert.doesNotMatch(content, /MCP 工具执行/);
    assert.doesNotMatch(content, /思考路径/);
    assert.doesNotMatch(content, /处理进度/);
    assert.doesNotMatch(content, /已收到请求/);
    assert.doesNotMatch(content, /会话、权限/);
    assert.doesNotMatch(content, /正在选择执行器/);
    assert.doesNotMatch(content, /JsonTool/);
    assert.doesNotMatch(content, /shell_artifact/);
  });

  it('renders final cards with an answer-derived header and compact completion mark', () => {
    const card = JSON.parse(buildFinalCardJson('自我介绍\n这个我处理好了。', [
      { id: 'tool-1', name: 'JsonTool:shell_artifact', status: 'complete' },
    ], { status: '已完成', elapsed: '1.2s' })) as {
      header?: { title?: { content?: string }; template?: string };
      body?: { elements?: Array<{ content?: string; text_size?: string }> };
    };
    const elements = card.body?.elements || [];
    const content = elements.map((element) => element.content || '').join('\n');
    const footer = elements.find((element) => String(element.content || '').includes('耗时'));

    assert.equal(card.header?.title?.content, '自我介绍');
    assert.equal(card.header?.template, 'purple');
    assert.match(content, /这个我处理好了/);
    assert.doesNotMatch(content, /最终结果/);
    assert.doesNotMatch(content, /处理完成/);
    assert.doesNotMatch(content, /状态：已完成[\s\S]*这个我处理好了/);
    assert.match(content, /工具轨迹/);
    assert.match(content, /桌面截图/);
    assert.match(content, /<font color="green">已完成<\/font>/);
    assert.match(content, /✅/);
    assert.match(content, /耗时：1\.2s/);
    assert.equal(footer?.text_size, 'notation');
    assert.doesNotMatch(content, /JsonTool|shell_artifact/);
  });

  it('renders model and token usage in the final card footer when provided', () => {
    const card = JSON.parse(buildFinalCardJson('处理结果\n已完成。', [], { status: '已完成', elapsed: '1.2s' }, {
      executorId: 'codex',
      executorName: 'Codex CLI / SDK',
      provider: 'codex',
      modelSource: 'official',
      model: 'gpt-5',
      tokenUsage: {
        input_tokens: 12345,
        output_tokens: 678,
        cache_read_input_tokens: 2048,
        cache_creation_input_tokens: 128,
      },
    })) as {
      body?: { elements?: Array<{ content?: string; text_size?: string }> };
    };
    const footer = (card.body?.elements || []).find((element) => String(element.content || '').includes('Token'));

    assert.equal(footer?.text_size, 'notation');
    assert.match(String(footer?.content || ''), /来源：Codex CLI \/ SDK \(codex\)/);
    assert.match(String(footer?.content || ''), /模型：gpt-5 \(official\)/);
    assert.match(String(footer?.content || ''), /Token：输入 12,345 \/ 输出 678/);
    assert.match(String(footer?.content || ''), /Cache：读 2,048 \/ 写 128/);
  });

  it('renders external executor source without requiring a model label', () => {
    const card = JSON.parse(buildFinalCardJson('处理结果\n已交给外部执行器。', [], { status: '已完成', elapsed: '2.4s' }, {
      executorId: 'mavis-agent',
      executorName: 'Mavis Agent (mavis)',
      executorKind: 'agent',
      provider: 'mavis-agent',
    })) as {
      body?: { elements?: Array<{ content?: string; text_size?: string }> };
    };
    const footer = (card.body?.elements || []).find((element) => String(element.content || '').includes('来源'));

    assert.equal(footer?.text_size, 'notation');
    assert.match(String(footer?.content || ''), /来源：Mavis Agent \(mavis\) \(mavis-agent\)/);
    assert.doesNotMatch(String(footer?.content || ''), /模型：/);
  });

  it('keeps generated final card titles complete instead of clipping to a short prefix', () => {
    const card = JSON.parse(buildFinalCardJson([
      '今天（2026-06-06）的金融新闻',
      '',
      '1. 美股大跌，科技股领跌。',
      '2. 黄金回落，美元指数波动。',
    ].join('\n'), [], { status: '已完成', elapsed: '48.7s' })) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };

    assert.equal(card.header?.title?.content, '今天（2026-06-06）的金融新闻');
    assert.match(String(card.body?.elements?.[0]?.content || ''), /美股大跌/);
  });

  it('removes model completion marks from the final body while keeping footer status', () => {
    const card = JSON.parse(buildFinalCardJson([
      '我是小虾米呀，在这个飞书聊天里主要帮你处理 Unity、文件、脚本、本地工具和一些自动化任务。',
      '你直接说要查什么、改什么或生成什么，我会尽量直接动手做完再回你结果。',
      '',
      '✅',
    ].join('\n'), [], { status: '已完成', elapsed: '48.4s' })) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string; text_size?: string }> };
    };
    const elements = card.body?.elements || [];
    const main = String(elements[0]?.content || '');
    const content = elements.map((element) => element.content || '').join('\n');
    const footer = elements.find((element) => String(element.content || '').includes('耗时'));

    assert.equal(card.header?.title?.content, '自我介绍');
    assert.match(main, /我是小虾米呀/);
    assert.doesNotMatch(main, /✅\s*$/);
    assert.match(String(footer?.content || ''), /✅/);
    assert.match(content, /耗时：48\.4s/);
  });

  it('keeps lightweight reply text in the final body when only a status mark follows', () => {
    const card = JSON.parse(buildFinalCardJson([
      '收到满月脸啦，小虾米在这儿呢~',
      '',
      '✅',
    ].join('\n'), [], { status: '已完成', elapsed: '35.5s' })) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string; text_size?: string }> };
    };
    const elements = card.body?.elements || [];
    const main = String(elements[0]?.content || '');
    const footer = elements.find((element) => String(element.content || '').includes('耗时'));

    assert.equal(card.header?.title?.content, '表情回复');
    assert.match(main, /收到满月脸啦，小虾米在这儿呢~/);
    assert.doesNotMatch(main, /^\s*✅\s*$/);
    assert.doesNotMatch(main, /✅/);
    assert.match(String(footer?.content || ''), /✅/);
  });

  it('ignores reaction hints when summarizing final card titles', () => {
    const card = JSON.parse(buildFinalCardJson([
      '[表情] 收到满月脸啦，小虾米在这儿呢~',
      '',
      '✅',
    ].join('\n'), [], { status: '已完成', elapsed: '35.5s' })) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    const main = String(card.body?.elements?.[0]?.content || '');

    assert.equal(card.header?.title?.content, '表情回复');
    assert.doesNotMatch(String(card.header?.title?.content || ''), /表情\]/);
    assert.match(main, /\[表情\] 收到满月脸啦/);
    assert.doesNotMatch(main, /✅/);
  });

  it('keeps checklist marks inside the final body', () => {
    const card = JSON.parse(buildFinalCardJson([
      '处理结果',
      '- ✅ 已完成测试',
      '- 已同步 live',
      '',
      '✅',
    ].join('\n'), [], { status: '已完成', elapsed: '2.0s' })) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const main = String(card.body?.elements?.[0]?.content || '');

    assert.match(main, /- ✅ 已完成测试/);
    assert.doesNotMatch(main, /✅\s*$/);
  });

  it('extracts explicit titles only when the remaining body has content', () => {
    const titled = JSON.parse(buildFinalCardJson([
      '摘要标题',
      '正文内容',
      '',
      '✅',
    ].join('\n'), [], { status: '已完成', elapsed: '1.0s' })) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    assert.equal(titled.header?.title?.content, '摘要标题');
    assert.equal(titled.body?.elements?.[0]?.content, '正文内容');

    const untitled = JSON.parse(buildFinalCardJson([
      '摘要标题',
      '',
      '✅',
    ].join('\n'), [], { status: '已完成', elapsed: '1.0s' })) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    assert.equal(untitled.header?.title?.content, '摘要标题');
    assert.equal(untitled.body?.elements?.[0]?.content, '摘要标题');
  });

  it('removes trailing failure marks from the final body while keeping failed footer', () => {
    const card = JSON.parse(buildFinalCardJson([
      '未完成',
      '缺少必要授权，暂时无法继续。',
      '',
      '×',
    ].join('\n'), [], { status: '执行失败', elapsed: '3.6s' })) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    const main = String(card.body?.elements?.[0]?.content || '');
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.equal(card.header?.title?.content, '未完成');
    assert.doesNotMatch(main, /×\s*$/);
    assert.match(content, /×/);
    assert.match(content, /耗时：3\.6s/);
  });

  it('keeps final cards non-empty when the provider returns no visible result', () => {
    const card = JSON.parse(buildFinalCardJson('', [], { status: '执行失败', elapsed: '36.7s' })) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.doesNotMatch(content, /状态：执行失败/);
    assert.doesNotMatch(content, /最终结果/);
    assert.match(content, /×/);
    assert.match(content, /未完成：模型没有返回可展示结果/);
    assert.match(content, /耗时：36\.7s/);
  });
});
