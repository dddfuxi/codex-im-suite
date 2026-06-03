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
    assert.match(content, /状态：已完成/);
    assert.match(content, /最终结果/);
    assert.match(content, /可用工具 12 个/);
    assert.doesNotMatch(content, /处理思路/);
  });

  it('reports streaming cards as enabled by default', () => {
    const report = buildFeishuCapabilityReport({
      getSetting: () => '',
    });
    assert.match(report, /Streaming card enabled: yes/);
  });

  it('renders workflow progress without leaking internal JSON tool names', () => {
    const content = buildStreamingContent('### 处理进度\n- 正在执行截图。', [
      { id: 'tool-1', name: 'JsonTool:shell_artifact', status: 'complete' },
      { id: 'tool-2', name: 'JsonTool:mcp_call', status: 'running' },
    ]);

    assert.match(content, /桌面截图/);
    assert.match(content, /MCP 工具执行/);
    assert.doesNotMatch(content, /JsonTool/);
    assert.doesNotMatch(content, /shell_artifact/);
  });

  it('renders final card status and visible tool trajectory without protocol names', () => {
    const card = JSON.parse(buildFinalCardJson('这个我处理好了。', [
      { id: 'tool-1', name: 'JsonTool:shell_artifact', status: 'complete' },
    ], { status: '已完成', elapsed: '1.2s' })) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(content, /状态：已完成/);
    assert.match(content, /最终结果/);
    assert.match(content, /工具轨迹/);
    assert.match(content, /桌面截图/);
    assert.match(content, /耗时：1\.2s/);
    assert.doesNotMatch(content, /JsonTool|shell_artifact/);
  });

  it('keeps final cards non-empty when the provider returns no visible result', () => {
    const card = JSON.parse(buildFinalCardJson('', [], { status: '执行失败', elapsed: '36.7s' })) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(content, /状态：执行失败/);
    assert.match(content, /最终结果/);
    assert.match(content, /未完成：模型没有返回可展示结果/);
    assert.match(content, /耗时：36\.7s/);
  });
});
