import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildToolProgressMarkdown,
  buildFinalCardJson,
  buildPostContent,
  buildStreamingContent,
  extractStreamingFinalResponse,
  preprocessFeishuMarkdown,
} from '../../lib/bridge/markdown/feishu.js';
import { buildFeishuCapabilityReport } from '../../lib/bridge/feishu-capabilities.js';

describe('Feishu streaming card markdown', () => {
  it('normalizes unsupported underline tags without touching fenced code', () => {
    const markdown = preprocessFeishuMarkdown([
      '<u>关键结论</u>，<ins>必须处理</ins>。',
      '',
      '```html',
      '<u>代码示例保持原样</u>',
      '```',
    ].join('\n'));

    assert.match(markdown, /<font color='blue'>\*\*关键结论\*\*<\/font>/u);
    assert.match(markdown, /<font color='blue'>\*\*必须处理\*\*<\/font>/u);
    assert.match(markdown, /```html\n<u>代码示例保持原样<\/u>\n```/u);
  });

  it('keeps Feishu section, quote, emphasis, and list syntax intact', () => {
    const markdown = preprocessFeishuMarkdown([
      '**结论**',
      '> 原文依据',
      '',
      '- **重点**：已经完成',
      '- *补充*：等待验收',
    ].join('\n'));

    assert.match(markdown, /^\*\*结论\*\*/u);
    assert.match(markdown, /^> 原文依据$/mu);
    assert.match(markdown, /- \*\*重点\*\*：已经完成/u);
    assert.match(markdown, /- \*补充\*：等待验收/u);
  });

  it('separates a bold label from adjacent body text for Card Markdown', () => {
    const markdown = preprocessFeishuMarkdown('**状态：**已完成\n\n```md\n**状态：**已完成\n```');

    assert.match(markdown, /^\*\*状态：\*\* 已完成/u);
    assert.match(markdown, /```md\n\*\*状态：\*\*已完成\n```/u);

    const card = JSON.parse(buildFinalCardJson('**结论：**可以发布', [], null)) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');
    assert.match(content, /\*\*结论：\*\* 可以发布/u);
  });

  it('renders Bash tool traces as safe user-visible action summaries', () => {
    const markdown = buildToolProgressMarkdown([
      {
        id: 'read-status',
        name: 'Bash',
        status: 'complete',
        input: {
          command: "Get-Content -LiteralPath 'C:\\Users\\admin\\.claude-to-im\\runtime\\status.json' -Encoding UTF8",
        },
      },
      {
        id: 'test-core',
        name: 'Bash',
        status: 'complete',
        input: { command: 'npm run test:core' },
      },
      {
        id: 'sync-live',
        name: 'Bash',
        status: 'complete',
        input: { command: 'powershell -ExecutionPolicy Bypass -File .\\scripts\\sync-live-skill.ps1' },
      },
    ]);

    assert.match(markdown, /读取状态文件/);
    assert.match(markdown, /运行测试/);
    assert.match(markdown, /同步 live skill/);
    assert.doesNotMatch(markdown, /Bash/);
    assert.doesNotMatch(markdown, /Get-Content|npm run|powershell/i);
    assert.doesNotMatch(markdown, /C:\\Users\\admin/);
  });

  it('moves user-visible rationale into a collapsed execution detail panel when finalizing a progress card', () => {
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
      body?: {
        elements?: Array<{
          tag?: string;
          content?: string;
          expanded?: boolean;
          header?: { title?: { content?: string } };
          elements?: Array<{ content?: string }>;
        }>;
      };
    };
    const elements = card.body?.elements || [];
    const main = String(elements[0]?.content || '');
    const detailPanel = elements.find((element) => element.tag === 'collapsible_panel');
    const detail = (detailPanel?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(main, /- .*12/);
    assert.doesNotMatch(main, /处理思路/);
    assert.doesNotMatch(main, /先确认 MCP/);
    assert.equal(detailPanel?.expanded, false);
    assert.equal(detailPanel?.header?.title?.content, '执行轨迹');
    assert.match(detail, /处理思路/);
    assert.match(detail, /先确认 MCP/);
  });

  it('preserves rationale headings inside the collapsed execution detail panel', () => {
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
      body?: {
        elements?: Array<{
          tag?: string;
          content?: string;
          expanded?: boolean;
          elements?: Array<{ content?: string }>;
        }>;
      };
    };
    const elements = card.body?.elements || [];
    const main = String(elements[0]?.content || '');
    const detailPanel = elements.find((element) => element.tag === 'collapsible_panel');
    const detail = (detailPanel?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(main, /可用工具 12 个/);
    assert.doesNotMatch(main, /处理思路/);
    assert.equal(detailPanel?.expanded, false);
    assert.match(detail, /^\*\*.+\*\*/m);
    assert.doesNotMatch(detail, /执行结果/);
  });

  it('renders structured mentions in finalized card markdown', () => {
    const card = JSON.parse(buildFinalCardJson('@张三 哈喽呀', [], null, undefined, [
      { userId: 'ou_target', name: '张三' },
    ])) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(content, /<at id="ou_target"><\/at>/);
    assert.doesNotMatch(content, /@张三/);
  });

  it('does not leak native at tags into the finalized card title', () => {
    const card = JSON.parse(buildFinalCardJson([
      '<at userid="all">所有人</at> <at userid="ou_bot">机器人</at>',
      '@所有人 @机器人 都通知到了。',
    ].join('\n'), [], null)) as {
      header?: { title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };

    const title = String(card.header?.title?.content || '');
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');
    assert.doesNotMatch(title, /<\/?at\b|userid=/iu);
    assert.match(title, /所有人|机器人/u);
    assert.match(content, /都通知到了/u);
  });

  it('renders post mentions in text order even when mention metadata order differs', () => {
    const post = JSON.parse(buildPostContent('@Bob and @Alice', [
      { userId: 'ou_alice', name: 'Alice' },
      { userId: 'ou_bob', name: 'Bob' },
    ]));
    const row = post.zh_cn.content[0];

    assert.deepEqual(row[0], { tag: 'at', user_id: 'ou_bob', user_name: 'Bob' });
    assert.deepEqual(row[1], { tag: 'text', text: ' and ' });
    assert.deepEqual(row[2], { tag: 'at', user_id: 'ou_alice', user_name: 'Alice' });
  });

  it('reports streaming cards as enabled by default', () => {
    const report = buildFeishuCapabilityReport({
      getSetting: () => '',
    });
    assert.match(report, /Streaming card enabled: yes/);
  });

  it('reports Feishu CLI as disabled by default and keeps cloud history on the adapter path', () => {
    const report = buildFeishuCapabilityReport({
      getSetting: () => '',
    }, {
      feishuCliProbe: () => {
        throw new Error('CLI probe should not run while disabled');
      },
    });

    assert.match(report, /Feishu CLI diagnostics/);
    assert.match(report, /CLI enabled: no/);
    assert.match(report, /Cloud chat history path: Feishu OpenAPI adapter/);
    assert.match(report, /CLI is diagnostic only/);
  });

  it('reports Feishu CLI version and resolved path when diagnostics are enabled', () => {
    let probedPath = '';
    const report = buildFeishuCapabilityReport({
      getSetting: (key) => ({
        bridge_feishu_cli_enabled: 'true',
        bridge_feishu_cli_path: 'C:\\Tools\\lark-cli.ps1',
      } as Record<string, string>)[key] || '',
    }, {
      feishuCliProbe: (cliPath) => {
        probedPath = cliPath;
        return {
          ok: true,
          version: 'lark-cli version 1.0.1',
          resolvedPath: 'C:\\Tools\\lark-cli.ps1',
        };
      },
    });

    assert.equal(probedPath, 'C:\\Tools\\lark-cli.ps1');
    assert.match(report, /CLI enabled: yes/);
    assert.match(report, /CLI path: C:\\Tools\\lark-cli\.ps1/);
    assert.match(report, /CLI probe: ready/);
    assert.match(report, /CLI version: lark-cli version 1\.0\.1/);
  });

  it('reports Feishu CLI blockers without claiming it is connected', () => {
    const report = buildFeishuCapabilityReport({
      getSetting: (key) => ({
        bridge_feishu_cli_enabled: '1',
        bridge_feishu_cli_path: 'missing-lark-cli',
      } as Record<string, string>)[key] || '',
    }, {
      feishuCliProbe: () => ({
        ok: false,
        error: 'command not found',
      }),
    });

    assert.match(report, /CLI enabled: yes/);
    assert.match(report, /CLI probe: blocked/);
    assert.match(report, /CLI blocker: command not found/);
    assert.doesNotMatch(report, /CLI probe: ready/);
  });

  it('renders a single polished thinking step with stage accents and a muted body', () => {
    const content = buildStreamingContent('### 处理思路\n正在理解问题。\n正在确认需要截图证据。', [
      { id: 'tool-1', name: 'JsonTool:shell_artifact', status: 'complete' },
      { id: 'tool-2', name: 'JsonTool:mcp_call', status: 'running' },
    ]);

    assert.match(content, /<font color="purple">\*\*确认证据\*\*<\/font>/);
    assert.match(content, /<font color="grey">正在确认需要截图证据。<\/font>/);
    assert.match(content, /✓ 理解/);
    assert.match(content, /✓ 证据/);
    assert.match(content, /● 执行/);
    assert.match(content, /○ 结果/);
    assert.match(content, /正在确认需要截图证据/);
    assert.doesNotMatch(content, /正在理解问题/);
    assert.match(content, /执行轨迹 1\/2/);
    assert.match(content, /桌面截图/);
    assert.match(content, /MCP 工具执行/);
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
      body?: { elements?: Array<{ tag?: string; content?: string; text_size?: string; elements?: Array<{ content?: string }> }> };
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
    const detailPanel = elements.find((element) => element.tag === 'collapsible_panel') as
      | { elements?: Array<{ content?: string }> }
      | undefined;
    const detail = (detailPanel?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(detail, /工具轨迹/);
    assert.match(detail, /桌面截图/);
    assert.match(detail, /<font color="green">已完成<\/font>/);
    assert.match(content, /✅/);
    assert.match(content, /耗时：1\.2s/);
    assert.equal(footer?.text_size, 'notation');
    assert.doesNotMatch(detail, /JsonTool|shell_artifact/);
  });

  it('renders truthful evidence badges and a relative tool timeline', () => {
    const card = JSON.parse(buildFinalCardJson('处理结果\n测试和构建均已完成。', [
      {
        id: 'tool-1',
        name: 'Bash',
        status: 'complete',
        input: { command: 'npm run test' },
        startedAt: 1_000,
        completedAt: 1_500,
      },
      {
        id: 'tool-2',
        name: 'Bash',
        status: 'complete',
        input: { command: 'npm run build' },
        startedAt: 2_200,
        completedAt: 3_400,
      },
    ], { status: '已完成', elapsed: '2.4s' })) as {
      body?: { elements?: Array<{
        tag?: string;
        content?: string;
        header?: { title?: { content?: string } };
        elements?: Array<{ content?: string }>;
      }> };
    };
    const elements = card.body?.elements || [];
    const visible = elements.map((element) => element.content || '').join('\n');
    const detailPanel = elements.find((element) => element.tag === 'collapsible_panel');
    const detail = (detailPanel?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(visible, /● 结果已生成/);
    assert.match(visible, /● 工具证据 2\/2/);
    assert.equal(detailPanel?.header?.title?.content, '执行轨迹');
    assert.match(detail, /\+0ms/);
    assert.match(detail, /\+1\.2s/);
    assert.match(detail, /运行测试/);
    assert.match(detail, /构建项目/);
    assert.match(detail, /\(500ms\)/);
    assert.match(detail, /\(1\.2s\)/);
  });

  it('labels a no-tool answer as text-only instead of claiming verification', () => {
    const card = JSON.parse(buildFinalCardJson(
      '普通解释回复。',
      [],
      { status: '已完成', elapsed: '0.8s' },
    )) as { body?: { elements?: Array<{ content?: string }> } };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.match(content, /● 结果已生成/);
    assert.match(content, /● 仅文本回复/);
    assert.doesNotMatch(content, /现场已验证|工具证据/);
  });

  it('does not mark successful summaries as incomplete when the body quotes errors', () => {
    const card = JSON.parse(buildFinalCardJson([
      '群里刚才主要在调侃群聊就报错这件事。',
      '后面几个人在说学习一下这个做事方法。',
    ].join('\n'), [], { status: '已完成', elapsed: '23.2s' })) as {
      header?: { title?: { content?: string }; template?: string };
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.notEqual(card.header?.title?.content, '未完成');
    assert.equal(card.header?.template, 'purple');
    assert.match(content, /群聊就报错/);
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
      body?: { elements?: Array<{ tag?: string; content?: string; text_size?: string; elements?: Array<{ content?: string }> }> };
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

  it('does not classify a substantive game result as an emoji reply because it contains tone particles', () => {
    const card = JSON.parse(buildFinalCardJson([
      '这轮判断结果如下啦～',
      '',
      '- 你的问题：那个人认识酒保吗？',
      '- 主持人回答：不是',
      '- 当前公开线索：酒保的行为与危险无关',
      '',
      '请继续根据公开线索提问。',
    ].join('\n'), [], { status: '已完成', elapsed: '3.2s' })) as {
      header?: { title?: { content?: string } };
    };

    assert.notEqual(card.header?.title?.content, '表情回复');
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

  it('uses a red header when visible content is unfinished even if transport status completed', () => {
    const card = JSON.parse(buildFinalCardJson(
      '未完成：当前缺少目标发送权限。',
      [],
      { status: '已完成', elapsed: '1.2s' },
    )) as {
      header?: { template?: string; title?: { content?: string } };
      body?: { elements?: Array<{ content?: string }> };
    };
    const content = (card.body?.elements || []).map((element) => element.content || '').join('\n');

    assert.equal(card.header?.template, 'red');
    assert.equal(card.header?.title?.content, '未完成');
    assert.match(content, /×/);
    assert.doesNotMatch(content, /✅/);
  });
});
