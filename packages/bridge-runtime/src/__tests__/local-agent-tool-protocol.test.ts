import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildJsonToolProtocolPrompt,
  buildCtiFinalToolResponseEnvelope,
  buildCtiFinalToolAnswer,
  buildCtiFinalToolAnswerAfterArtifactSettle,
  buildDeterministicToolAnswer,
  buildJsonToolFinalResponsePrompt,
  buildVisibleToolOutcomeFallback,
  normalizeGeneratedToolFinalText,
  buildToolResultPrompt,
  buildFallbackJsonToolRequest,
  executeJsonToolRequest,
  isJsonToolProtocolEligible,
  parseJsonToolRequest,
  planConfiguredJsonToolRequest,
  planDeterministicJsonToolRequest,
  validateJsonToolRequest,
} from '../local-agent-tool-protocol.js';

describe('local agent JSON tool protocol', () => {
  it('parses a strict JSON tool request from local model text', () => {
    const request = parseJsonToolRequest('{"action":"tool_request","tool":"list_dir","args":{"path":"Game","kind":"folders"}}');

    assert.equal(request?.action, 'tool_request');
    assert.equal(request?.tool, 'list_dir');
    assert.deepEqual(request?.args, { path: 'Game', kind: 'folders' });
  });

  it('executes a validated directory listing inside allowed roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-'));
    try {
      fs.mkdirSync(path.join(root, 'Game'));
      fs.mkdirSync(path.join(root, 'Game', 'Assets'));
      fs.mkdirSync(path.join(root, 'Game', 'Library'));
      fs.writeFileSync(path.join(root, 'Game', 'README.md'), 'hello', 'utf-8');

      const request = parseJsonToolRequest('{"action":"tool_request","tool":"list_dir","args":{"path":"Game","kind":"folders"}}');
      assert.ok(request);
      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, true);
      assert.equal(validation.request?.args.path, path.join(root, 'Game'));

      const result = executeJsonToolRequest(validation.request!);
      assert.equal(result.ok, true);
      assert.equal(result.tool, 'list_dir');
      assert.deepEqual((result.data as { entries: Array<{ name: string }> }).entries.map((item) => item.name), ['Assets', 'Library']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects paths outside allowed roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-outside-'));
    try {
      const request = parseJsonToolRequest(JSON.stringify({
        action: 'tool_request',
        tool: 'read_file',
        args: { path: path.join(outside, 'secret.txt') },
      }));
      assert.ok(request);

      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });

      assert.equal(validation.ok, false);
      assert.match(validation.error || '', /outside allowed roots/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('builds prompts and eligibility for evidence tasks on local_api', () => {
    assert.equal(isJsonToolProtocolEligible({ kind: 'local_read_required' }, 'local_api'), true);
    assert.equal(isJsonToolProtocolEligible({ kind: 'local_read_required' }, 'official'), false);
    assert.equal(isJsonToolProtocolEligible({ kind: 'tool_required' }, 'local_api'), true);
    assert.equal(isJsonToolProtocolEligible({ kind: 'artifact_required' }, 'local_api'), true);

    const prompt = buildJsonToolProtocolPrompt(
      { kind: 'local_read_required', reason: 'read local state', requiredToolFamilies: ['read'] },
      ['list_dir', 'read_file'],
      { workingDirectory: 'C:\\unity\\ST3', allowedRoots: ['C:\\unity\\ST3'] },
    );
    assert.match(prompt, /tool_request/);
    assert.match(prompt, /list_dir/);

    const shellPrompt = buildJsonToolProtocolPrompt(
      { kind: 'tool_required', reason: 'run command', requiredToolFamilies: ['shell'] },
      ['unity_mcp_execute_code', 'shell'],
      { workingDirectory: 'C:\\unity\\ST3', allowedRoots: ['C:\\unity\\ST3'] },
    );
    assert.match(shellPrompt, /shell/);
    assert.match(shellPrompt, /unity_mcp_execute_code/);

    const artifactPrompt = buildJsonToolProtocolPrompt(
      { kind: 'artifact_required', reason: 'create screenshot', requiredToolFamilies: ['artifact'] },
      ['shell_artifact'],
      { workingDirectory: 'C:\\unity\\ST3', allowedRoots: ['C:\\unity\\ST3'] },
    );
    assert.match(artifactPrompt, /shell_artifact/);
    assert.match(artifactPrompt, /artifact-producing/);

    const mcpPrompt = buildJsonToolProtocolPrompt(
      { kind: 'tool_required', reason: 'switch Unity scene', requiredToolFamilies: ['unity-mcp', 'mcp'] },
      ['mcp_call'],
      { workingDirectory: 'C:\\unity\\ST3', allowedRoots: ['C:\\unity\\ST3'] },
      [{
        manifestHint: 'unitymcp',
        tool: 'manage_scene',
        description: 'Load or inspect Unity scenes.',
        inputSchema: { properties: { action: { enum: ['load'] }, path: { type: 'string' } } },
      }],
    );
    assert.match(mcpPrompt, /Available MCP tool schemas/);
    assert.match(mcpPrompt, /manage_scene/);
    assert.match(mcpPrompt, /If an exact tool argument/);

    const resultPrompt = buildToolResultPrompt(
      { tool: 'list_dir', ok: true, data: { entries: [{ name: 'Assets', type: 'directory' }] } },
      'list folders',
    );
    assert.match(resultPrompt, /Assets/);
    assert.match(resultPrompt, /Current user request/);
  });

  it('builds a user-facing final response prompt and cti-final envelope after tools run', () => {
    const history = [{
      request: {
        action: 'tool_request' as const,
        tool: 'mcp_call' as const,
        args: {
          manifestHint: 'unitymcp',
          tool: 'manage_scene',
          arguments: { action: 'load', path: 'Assets/Scenes/Main.unity' },
        },
      },
      result: {
        tool: 'mcp_call',
        ok: true,
        data: {
          server: 'unityMCP',
          tool: 'manage_scene',
          result: JSON.stringify({
            success: true,
            message: 'Scene loaded successfully.',
            data: { name: 'Main', path: 'Assets/Scenes/Main.unity' },
          }),
          durationMs: 12,
        },
      },
    }];

    const prompt = buildJsonToolFinalResponsePrompt('切换 Main 场景', history, {
      replyStyleHint: '像项目助理，先说结果',
    });
    assert.match(prompt, /Final answer composer/);
    assert.match(prompt, /Required reply style: 像项目助理/);
    assert.match(prompt, /Convert successful tool evidence into the most helpful completed answer/);
    assert.match(prompt, /If only part of the request is satisfied, keep the completed part/);
    assert.match(prompt, /Do not ask the user to manually inspect/);
    assert.doesNotMatch(prompt, /You MUST include the headings/);
    assert.match(prompt, /Scene loaded successfully/);
    assert.doesNotMatch(prompt, /```cti-final/);

    const fallback = buildVisibleToolOutcomeFallback('切换 Main 场景', history);
    assert.doesNotMatch(fallback, /处理思路/);
    assert.match(fallback, /Scene loaded successfully/);
    assert.doesNotMatch(fallback, /"success":true/);

    const normalized = normalizeGeneratedToolFinalText('```cti-final\n{"kind":"text","text":"**处理思路**\\n- 已根据真实工具结果确认。\\n\\n**执行结果**\\n- 已完成","images":[],"files":[],"reply_mode":"markdown"}\n```', fallback);
    assert.match(normalized, /已完成/);
    assert.doesNotMatch(normalized, /cti-final/);

    const cleaned = normalizeGeneratedToolFinalText('### 处理思路\n已基于真实工具结果确认。\n\n### 执行结果\n- 已成功加载场景。\n\n未完成：无具体 blocker，已成功切换至目标场景。', fallback);
    assert.match(cleaned, /已成功加载场景/);
    assert.doesNotMatch(cleaned, /未完成/);

    const envelope = buildCtiFinalToolResponseEnvelope(normalized, { images: [], files: [] }, 'markdown');
    assert.match(envelope, /```cti-final/);
    assert.match(envelope, /"reply_mode":"markdown"/);
    assert.match(envelope, /已完成/);
  });

  it('keeps user-visible rationale sections in normalized final text', () => {
    const fallback = '已根据真实工具结果完成。';
    const normalized = normalizeGeneratedToolFinalText([
      '**处理思路**',
      '- 已根据真实工具结果确认目标场景路径。',
      '',
      '**执行结果**',
      '- 已成功切换到 Main 场景。',
    ].join('\n'), fallback);

    assert.match(normalized, /处理思路/);
    assert.match(normalized, /执行结果/);
    assert.match(normalized, /Main 场景/);
  });

  it('can build a deterministic final answer from list_dir results', () => {
    const answer = buildDeterministicToolAnswer({
      tool: 'list_dir',
      ok: true,
      data: {
        path: 'C:\\unity\\ST3\\Game',
        entries: [
          { name: 'Assets', type: 'directory' },
          { name: 'Library', type: 'directory' },
        ],
      },
    });

    assert.match(answer || '', /Assets/);
    assert.match(answer || '', /Library/);
  });

  it('builds a conservative fallback tool request for local directory listing prompts', () => {
    const request = buildFallbackJsonToolRequest('你能看一眼本地工作目录Game里都有哪些文件夹吗', {
      workingDirectory: 'C:\\unity\\ST3',
    });

    assert.equal(request?.tool, 'list_dir');
    assert.equal(request?.args.path, 'Game');
    assert.equal(request?.args.kind, 'folders');
  });

  it('resolves common project folders under a unique child directory when the working directory is the parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-unity-'));
    try {
      fs.mkdirSync(path.join(root, 'ProjectA', 'Assets'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ProjectA', 'Assets', 'Scenes'));
      fs.mkdirSync(path.join(root, 'ProjectA', 'Assets', 'Scripts'));

      const request = buildFallbackJsonToolRequest('Assets下的目录都有啥', {
        workingDirectory: root,
      });
      assert.equal(request?.tool, 'list_dir');
      assert.equal(request?.args.path, path.join('ProjectA', 'Assets'));

      const validation = validateJsonToolRequest(request!, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, true);
      const result = executeJsonToolRequest(validation.request!);
      assert.equal(result.ok, true);
      assert.deepEqual((result.data as { entries: Array<{ name: string }> }).entries.map((item) => item.name), ['Scenes', 'Scripts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses contextual absolute paths when common project folders are ambiguous', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-context-'));
    try {
      fs.mkdirSync(path.join(root, 'ProjectA', 'Assets'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ProjectB', 'Assets'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ProjectA', 'Assets', 'Scenes'));

      const request = buildFallbackJsonToolRequest('Assets下的目录都有啥', {
        workingDirectory: root,
        contextText: `上一轮读取过 ${path.join(root, 'ProjectA')} 下的目录。`,
      });
      assert.equal(request?.tool, 'list_dir');
      assert.equal(request?.args.path, path.join('ProjectA', 'Assets'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses contextual absolute paths while validating model-produced relative paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-validate-context-'));
    try {
      fs.mkdirSync(path.join(root, 'ProjectA', 'Assets'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ProjectB', 'Assets'), { recursive: true });
      const request = parseJsonToolRequest('{"action":"tool_request","tool":"list_dir","args":{"path":"Assets","kind":"folders"}}');
      assert.ok(request);
      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
        contextText: `上一轮读取过 ${path.join(root, 'ProjectA')} 下的目录。`,
      });
      assert.equal(validation.ok, true);
      assert.equal(validation.request?.args.path, path.join(root, 'ProjectA', 'Assets'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous project-relative paths instead of guessing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-ambiguous-'));
    try {
      fs.mkdirSync(path.join(root, 'ProjectA', 'Assets'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ProjectB', 'Assets'), { recursive: true });
      const request = parseJsonToolRequest('{"action":"tool_request","tool":"list_dir","args":{"path":"Assets","kind":"folders"}}');
      assert.ok(request);
      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, false);
      assert.match(validation.error || '', /candidates are not unique/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds and executes a shell request inside allowed roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-shell-'));
    try {
      const request = parseJsonToolRequest(JSON.stringify({
        action: 'tool_request',
        tool: 'shell',
        args: { command: `"${process.execPath}" -e "console.log('shell-ok')"`, cwd: root },
      }));
      assert.ok(request);
      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, true);
      const result = executeJsonToolRequest(validation.request!);
      assert.equal(result.ok, true);
      assert.equal((result.data as { exitCode: number }).exitCode, 0);
      assert.match((result.data as { stdout: string }).stdout, /shell-ok/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('plans deterministic runtime tool requests for safe executable and read-only tasks', () => {
    const shellPlan = planDeterministicJsonToolRequest('node -e "console.log(123)"', {
      workingDirectory: 'C:\\unity\\ST3',
      requirementKind: 'tool_required',
    });
    assert.equal(shellPlan?.request.tool, 'shell');
    assert.equal(shellPlan?.source, 'runtime_deterministic');

    const readPlan = planDeterministicJsonToolRequest('看一下工作目录', {
      workingDirectory: 'C:\\unity\\ST3',
      requirementKind: 'local_read_required',
    });
    assert.equal(readPlan?.request.tool, 'list_dir');
    assert.equal(readPlan?.source, 'runtime_deterministic');

    const mcpPlan = planDeterministicJsonToolRequest('Unitymcp截一个game图', {
      workingDirectory: 'C:\\unity\\ST3',
      requirementKind: 'tool_required',
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot',
        match: { regex: ['(?:unitymcp|unity).*截.*game'] },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }],
    });
    assert.equal(mcpPlan?.request.tool, 'mcp_call');
    assert.equal(mcpPlan?.request.args.manifestHint, 'unitymcp');
    assert.equal(mcpPlan?.request.args.tool, 'manage_camera');
    assert.equal(mcpPlan?.source, 'runtime_deterministic');

    const prefabScreenshotPlan = planDeterministicJsonToolRequest('刚刚摆的prefab摆截图给我', {
      workingDirectory: 'C:\\unity\\ST3\\Game',
      requirementKind: 'artifact_required',
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot',
        match: {
          regex: [
            '(?:prefab|预制体|场景).*(?:截图|截个图|screenshot)',
            '(?:截图|截个图|screenshot).*(?:prefab|预制体|场景)',
          ],
        },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }],
    });
    assert.equal(prefabScreenshotPlan?.request.tool, 'mcp_call');
    assert.equal(prefabScreenshotPlan?.request.args.tool, 'manage_camera');

    const shortUnityScreenshotPlan = planDeterministicJsonToolRequest('截个图给我', {
      workingDirectory: 'C:\\unity\\ST3\\Game',
      contextText: '当前绑定工作区：C:\\unity\\ST3\\Game\\Assets',
      requirementKind: 'artifact_required',
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot.contextual',
        match: {
          contextualRegex: ['^(?:截(?:图|个图|一张)?|截图)(?:给我|一下|看看|吧|呗|\\s|[。！？!?.])*$'],
          contextRegex: ['(?:^|[\\\\/])Assets(?:[\\\\/]|$)', 'Unity|unity|unitymcp'],
        },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }],
    });
    assert.equal(shortUnityScreenshotPlan?.request.tool, 'mcp_call');

    const shortNonUnityScreenshotPlan = planDeterministicJsonToolRequest('截个图给我', {
      workingDirectory: 'C:\\Users\\admin\\Documents\\New project\\codex-im-suite',
      contextText: '当前绑定工作区：C:\\Users\\admin\\Documents\\New project\\codex-im-suite',
      requirementKind: 'artifact_required',
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot.contextual',
        match: {
          contextualRegex: ['^(?:截(?:图|个图|一张)?|截图)(?:给我|一下|看看|吧|呗|\\s|[。！？!?.])*$'],
          contextRegex: ['(?:^|[\\\\/])Assets(?:[\\\\/]|$)', 'Unity|unity|unitymcp'],
        },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }],
    });
    assert.equal(shortNonUnityScreenshotPlan, null);

    const artifactPlan = planDeterministicJsonToolRequest('截图一下桌面给我看看', {
      workingDirectory: 'C:\\unity\\ST3',
      requirementKind: 'artifact_required',
      shellArtifactDefinitions: [{
        id: 'test.desktop.screenshot',
        displayName: 'Desktop Screenshot',
        match: { regex: ['(桌面|屏幕).*(截图|截屏)|(截图|截屏).*(桌面|屏幕)'] },
        command: 'echo ok',
        cwd: 'C:\\unity\\ST3',
        artifactPaths: ['C:\\Users\\admin\\.claude-to-im\\runtime\\captures\\desktop-latest.png'],
      }],
    });
    assert.equal(artifactPlan?.request.tool, 'shell_artifact');
    assert.equal(artifactPlan?.request.args.displayName, 'Desktop Screenshot');
  });

  it('plans configured manifest tools before an execution requirement is assigned', () => {
    const plan = planConfiguredJsonToolRequest('unitygame screenshot please', {
      workingDirectory: 'C:\\unity\\ST3',
      contextText: 'workingDirectory=C:\\unity\\ST3\nunityProjectPath=C:\\unity\\ST3\\Game',
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot',
        match: { regex: ['unity.*(?:game|screenshot)'] },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }],
    });

    assert.equal(plan?.request.tool, 'mcp_call');
    assert.equal(plan?.request.args.manifestHint, 'unitymcp');
    assert.equal(plan?.request.args.tool, 'manage_camera');
    assert.equal(plan?.reason, 'configured MCP tool action manifest');
  });

  it('plans configured manifest tools with unordered keyword groups', () => {
    const plan = planConfiguredJsonToolRequest('unitygame视角截个图', {
      workingDirectory: 'C:\\unity\\ST3',
      contextText: 'workingDirectory=C:\\unity\\ST3\nunityProjectPath=C:\\unity\\ST3\\Game',
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot',
        match: {
          keywordGroups: [['unity', 'game', '截']],
        },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }],
    });

    assert.equal(plan?.request.tool, 'mcp_call');
    assert.equal(plan?.request.args.manifestHint, 'unitymcp');
    assert.equal(plan?.request.args.tool, 'manage_camera');
  });

  it('executes a configured artifact request and returns image artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-artifact-'));
    try {
      const imagePath = path.join(root, 'desktop.png');
      const request = parseJsonToolRequest(JSON.stringify({
        action: 'tool_request',
        tool: 'shell_artifact',
        args: {
          command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], Buffer.from([0x89,0x50,0x4e,0x47]))" ${JSON.stringify(imagePath)}`,
          cwd: root,
          timeoutMs: 5000,
          artifactPaths: [imagePath],
          displayName: 'Desktop Screenshot',
        },
      }));
      assert.ok(request);

      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, true);

      const result = executeJsonToolRequest(validation.request!);
      assert.equal(result.ok, true);
      assert.equal(result.tool, 'shell_artifact');

      const answer = buildCtiFinalToolAnswer(result);
      assert.match(answer || '', /```cti-final/);
      assert.match(answer || '', /"kind":"image"/);
      assert.match(answer || '', /desktop\.png/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a failed shell result for non-zero exit codes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-shell-fail-'));
    try {
      const request = parseJsonToolRequest(JSON.stringify({
        action: 'tool_request',
        tool: 'shell',
        args: { command: `"${process.execPath}" -e "process.exit(2)"`, cwd: root },
      }));
      assert.ok(request);
      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, true);
      const result = executeJsonToolRequest(validation.request!);
      assert.equal(result.ok, false);
      assert.equal((result.data as { exitCode: number }).exitCode, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes configured Unity MCP aliases to execute_code instead of shell', () => {
    const request = buildFallbackJsonToolRequest(
      'powershell -ExecutionPolicy Bypass -File "C:\\unity\\ST3\\Game\\Assets\\FXTools\\Cli\\fxtools-cli.ps1" doctor 检查一下工具',
      {
        workingDirectory: 'C:\\unity\\ST3',
        requirementKind: 'tool_required',
        unityMcpExecuteCodeDefinitions: [{
          id: 'test.fxtools.doctor',
          match: { keywords: ['fxtools', 'doctor'] },
          codeTemplate: 'return "configured";',
        }],
      },
    );
    assert.equal(request?.tool, 'unity_mcp_execute_code');
    assert.equal(request?.args.code, 'return "configured";');
  });

  it('builds a conservative shell fallback from a non-Unity explicit command', () => {
    const request = buildFallbackJsonToolRequest(
      'powershell -ExecutionPolicy Bypass -File "C:\\unity\\ST3\\Game\\Tools\\check.ps1" doctor 检查一下工具',
      {
        workingDirectory: 'C:\\unity\\ST3',
        requirementKind: 'tool_required',
        unityMcpExecuteCodeDefinitions: [{
          id: 'test.fxtools.doctor',
          match: { keywords: ['fxtools', 'doctor'] },
          codeTemplate: 'return "configured";',
        }],
      },
    );
    assert.equal(request?.tool, 'shell');
    assert.equal(request?.args.command, 'powershell -ExecutionPolicy Bypass -File "C:\\unity\\ST3\\Game\\Tools\\check.ps1" doctor');
  });

  it('validates Unity MCP execute_code requests', () => {
    const request = parseJsonToolRequest(JSON.stringify({
      action: 'tool_request',
      tool: 'unity_mcp_execute_code',
      args: {
        code: 'return UnityEngine.Application.unityVersion;',
        compiler: 'auto',
        safety_checks: true,
      },
    }));
    assert.ok(request);
    const validation = validateJsonToolRequest(request, {
      workingDirectory: 'C:\\unity\\ST3',
      allowedRoots: ['C:\\unity\\ST3'],
    });
    assert.equal(validation.ok, true);
    assert.equal(validation.request?.tool, 'unity_mcp_execute_code');

    const answer = buildDeterministicToolAnswer({
      tool: 'unity_mcp_execute_code',
      ok: true,
      data: { result: '{"ok":true}', durationMs: 12 },
    });
    assert.match(answer || '', /Unity MCP execute_code/);
    assert.match(answer || '', /"ok":true/);
  });

  it('validates configured MCP tool call requests', () => {
    const request = parseJsonToolRequest(JSON.stringify({
      action: 'tool_request',
      tool: 'mcp_call',
      args: {
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: {
          action: 'screenshot',
          capture_source: 'game_view',
          include_image: false,
        },
      },
    }));
    assert.ok(request);
    const validation = validateJsonToolRequest(request, {
      workingDirectory: 'C:\\unity\\ST3',
      allowedRoots: ['C:\\unity\\ST3'],
    });
    assert.equal(validation.ok, true);
    assert.equal(validation.request?.tool, 'mcp_call');

    const answer = buildDeterministicToolAnswer({
      tool: 'mcp_call',
      ok: true,
      data: {
        server: 'unityMCP',
        tool: 'manage_camera',
        result: '{"success":true,"data":{"path":"Assets/Screenshots/test.png"}}',
        durationMs: 10,
      },
    });
    assert.match(answer || '', /MCP 工具执行完成/);
    assert.match(answer || '', /Assets\/Screenshots\/test\.png/);
  });

  it('builds cti-final image attachments from existing tool artifact paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-artifact-'));
    try {
      const imagePath = path.join(root, 'screenshot.png');
      fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const answer = buildCtiFinalToolAnswer({
        tool: 'mcp_call',
        ok: true,
        data: {
          server: 'unityMCP',
          tool: 'manage_camera',
          result: JSON.stringify({
            success: true,
            data: {
              path: 'Assets/Screenshots/screenshot.png',
              fullPath: imagePath,
            },
          }),
          durationMs: 10,
        },
      });

      assert.match(answer || '', /```cti-final/);
      assert.match(answer || '', /"kind":"image"/);
      assert.match(answer || '', /"reply_mode":"plain"/);
      assert.match(answer || '', /screenshot\.png/);
      const payloadText = (answer || '').replace(/^```cti-final\s*/u, '').replace(/\s*```$/u, '');
      const payload = JSON.parse(payloadText) as { images: string[]; files: string[] };
      assert.deepEqual(payload.images, [path.resolve(imagePath)]);
      assert.deepEqual(payload.files, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits briefly for asynchronous tool artifacts to settle before building cti-final', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-artifact-async-'));
    try {
      const imagePath = path.join(root, 'async-screenshot.png');
      const timer = setTimeout(() => {
        fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }, 60);
      const answer = await buildCtiFinalToolAnswerAfterArtifactSettle({
        tool: 'mcp_call',
        ok: true,
        data: {
          server: 'unityMCP',
          tool: 'manage_camera',
          result: JSON.stringify({
            success: true,
            data: {
              fullPath: imagePath,
              isAsync: true,
            },
          }),
          durationMs: 10,
        },
      }, 1000);
      clearTimeout(timer);

      assert.match(answer || '', /```cti-final/);
      assert.match(answer || '', /async-screenshot\.png/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers shell cwd from command paths when the model omits cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-shell-cwd-'));
    try {
      const script = path.join(root, 'ProjectA', 'Assets', 'FXTools', 'Cli', 'fxtools-cli.ps1');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '', 'utf-8');
      const request = parseJsonToolRequest(JSON.stringify({
        action: 'tool_request',
        tool: 'shell',
        args: { command: `powershell -ExecutionPolicy Bypass -File "${script}" doctor` },
      }));
      assert.ok(request);
      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, true);
      assert.equal(validation.request?.args.cwd, path.join(root, 'ProjectA'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects shell cwd outside allowed roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-shell-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-json-tool-shell-outside-'));
    try {
      const request = parseJsonToolRequest(JSON.stringify({
        action: 'tool_request',
        tool: 'shell',
        args: { command: 'echo hi', cwd: outside },
      }));
      assert.ok(request);
      const validation = validateJsonToolRequest(request, {
        workingDirectory: root,
        allowedRoots: [root],
      });
      assert.equal(validation.ok, false);
      assert.match(validation.error || '', /outside allowed roots/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
