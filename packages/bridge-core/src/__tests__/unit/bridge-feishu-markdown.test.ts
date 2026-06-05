import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFinalCardJson,
  buildStreamingContent,
  extractStreamingFinalResponse,
} from '../../lib/bridge/markdown/feishu.js';
import { buildFeishuCapabilityReport } from '../../lib/bridge/feishu-capabilities.js';

describe('Feishu streaming card markdown', () => {
  it('uses only the result section when finalizing a progress card', () => {
    const text = [
      '# 处理思路',
      '先确认 MCP 服务，再读取可用工具。',
      '',
      '# 执行结果',
      '- 可用工具 12 个。',
    ].join('\n');

    assert.equal(extractStreamingFinalResponse(text), '- 可用工具 12 个。');

    const card = JSON.parse(buildFinalCardJson(text, [], null)) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');
    assert.match(content, /可用工具 12 个/);
    assert.doesNotMatch(content, /状态：已完成/);
    assert.doesNotMatch(content, /处理思路/);
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
