import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CodexLocalCliProvider, buildClassifierCodexExecArgs } from '../codex-local-cli-provider.js';
import type { Config } from '../config.js';

function parseSseChunks(chunks: string[]): Array<{ type: string; data: unknown }> {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      const outer = JSON.parse(line.slice(6)) as { type: string; data: string };
      let data: unknown = outer.data;
      try {
        data = JSON.parse(outer.data);
      } catch {
        // text payloads are plain strings
      }
      return { type: outer.type, data };
    });
}

async function collectStream(stream: ReadableStream<string>): Promise<Array<{ type: string; data: unknown }>> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return parseSseChunks(chunks);
}

function makeConfig(root: string): Config {
  return {
    runtime: 'codex',
    enabledChannels: [],
    defaultWorkDir: root,
    allowedWorkspaceRoots: [root],
    codexAdditionalDirectories: [root],
    unityProjectPath: root,
    localAiKind: 'ollama',
    localAiBaseUrl: 'http://127.0.0.1:11434',
    localAiModel: 'qwen-test',
    localAiTimeoutMs: 45000,
    codexModelSource: 'local_api',
    codexPassModel: true,
    defaultMode: 'code',
    ollamaEnabled: true,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen-test',
    ollamaTimeoutMs: 45000,
    localLlmEnabled: true,
    localLlmBaseUrl: 'http://127.0.0.1:11434',
    localLlmModel: 'qwen-test',
    localLlmTimeoutMs: 45000,
  };
}

describe('CodexLocalCliProvider JSON tool protocol', () => {
  it('builds classifier CLI args without user config, tools, or writable sandbox', () => {
    const args = buildClassifierCodexExecArgs(['exec', '--json'], 'C:\\temp\\schema.json');

    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert.deepEqual(args.slice(args.indexOf('--output-schema'), args.indexOf('--output-schema') + 2), ['--output-schema', 'C:\\temp\\schema.json']);
    assert.ok(args.includes('shell_tool'));
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  });

  it('times out hanging codex exec processes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-codex-timeout-'));
    const oldPath = process.env.PATH || process.env.Path || '';
    try {
      const binDir = path.join(root, 'bin');
      fs.mkdirSync(binDir);
      const hangScript = path.join(binDir, 'hang.js');
      fs.writeFileSync(hangScript, 'setInterval(() => {}, 1000);\n', 'utf-8');
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${hangScript}"\r\n`, 'utf-8');
        process.env.PATH = `${binDir};${oldPath}`;
      } else {
        const codexPath = path.join(binDir, 'codex');
        fs.writeFileSync(codexPath, `#!/bin/sh\n"${process.execPath}" "${hangScript}"\n`, 'utf-8');
        fs.chmodSync(codexPath, 0o755);
        process.env.PATH = `${binDir}:${oldPath}`;
      }

      const provider = new CodexLocalCliProvider({
        ...makeConfig(root),
        bridgeProcessingTimeoutMs: 100,
      });
      const startedAt = Date.now();
      const events = await collectStream(provider.streamChat({
        sessionId: 'test-session-timeout',
        prompt: 'hello',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: { kind: 'none', reason: 'plain chat', requiredToolFamilies: [] },
      }));
      const elapsed = Date.now() - startedAt;
      const error = events.find((event) => event.type === 'error')?.data as string | undefined;

      assert.ok(elapsed < 5000, `expected timeout to finish quickly, elapsed=${elapsed}`);
      assert.match(error || '', /timed out after 1000ms/);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits structured input evidence after the local Codex CLI accepts an image turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-codex-image-evidence-'));
    const oldPath = process.env.PATH || process.env.Path || '';
    try {
      const binDir = path.join(root, 'bin');
      fs.mkdirSync(binDir);
      const successScript = path.join(binDir, 'success.js');
      fs.writeFileSync(successScript, [
        "console.log(JSON.stringify({type:'thread.started',thread_id:'local-image-thread'}));",
        "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'图片分析完成'}}));",
        "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));",
      ].join('\n'), 'utf-8');
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${successScript}"\r\n`, 'utf-8');
        process.env.PATH = `${binDir};${oldPath}`;
      } else {
        const codexPath = path.join(binDir, 'codex');
        fs.writeFileSync(codexPath, `#!/bin/sh\n"${process.execPath}" "${successScript}"\n`, 'utf-8');
        fs.chmodSync(codexPath, 0o755);
        process.env.PATH = `${binDir}:${oldPath}`;
      }

      const provider = new CodexLocalCliProvider(makeConfig(root));
      const events = await collectStream(provider.streamChat({
        sessionId: 'local-image-evidence',
        prompt: '分析这张图片',
        workingDirectory: root,
        permissionMode: 'default',
        files: [{ id: 'image-1', name: 'input.png', type: 'image/png', size: 4, data: 'AAAA' }],
        executionRequirement: {
          kind: 'input_evidence_required',
          reason: 'structured input evidence required',
          requiredToolFamilies: [],
          requiredInputEvidenceKinds: ['image'],
          requiredInputEvidenceIds: ['image-1'],
        },
      }));

      const receipt = events
        .filter((event) => event.type === 'status')
        .map((event) => event.data as Record<string, any>)
        .find((data) => data.inputEvidence?.protocol === 'cti-input-evidence/v1');
      assert.ok(receipt);
      assert.equal(receipt.inputEvidence.provider, 'ollama');
      assert.deepEqual(receipt.inputEvidence.accepted, [{ id: 'image-1', kind: 'image', mediaType: 'image/png' }]);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes deterministic runtime tool requests and lets the model compose the final reply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-provider-'));
    try {
      fs.mkdirSync(path.join(root, 'Assets'));
      const provider = new CodexLocalCliProvider(makeConfig(root));
      (provider as unknown as { runCodexExecText: (input: { promptOverride?: string; systemPromptAppend?: string }) => Promise<{ text: string; usage: null }> }).runCodexExecText = async ({ promptOverride, systemPromptAppend }) => {
        assert.match(promptOverride || '', /Final answer composer/);
        assert.match(promptOverride || '', /Required reply style: 像项目助理/);
        assert.match(systemPromptAppend || '', /Required reply style: 像项目助理/);
        return {
          text: '这个我处理好了：真实工具已经跑完，结果可用。',
          usage: null,
        };
      };

      const runProvider = async (params: Record<string, unknown>) => {
        const chunks: string[] = [];
        const controller = {
          enqueue: (chunk: string) => chunks.push(chunk),
        } as unknown as ReadableStreamDefaultController<string>;
        await (provider as unknown as {
          runJsonToolProtocol: (
            controller: ReadableStreamDefaultController<string>,
            params: Record<string, unknown>,
            model: string,
            baseUrl: string,
          ) => Promise<void>;
        }).runJsonToolProtocol(controller, params, 'qwen-test', 'http://127.0.0.1:11434');
        return parseSseChunks(chunks);
      };

      const shellEvents = await runProvider({
        sessionId: 'test-session-shell',
        prompt: 'node -e "console.log(\'cti-tool-required-ok\')"',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'tool_required',
          reason: 'regression requires a concrete shell command',
          requiredToolFamilies: ['shell'],
        },
        replyPresentation: {
          replyStyleHint: '像项目助理，先说结果，再说一句影响',
        },
      });

      const shellToolUse = shellEvents.find((event) => event.type === 'tool_use')?.data as { name?: string } | undefined;
      const shellToolResult = shellEvents.find((event) => event.type === 'tool_result')?.data as { is_error?: boolean; content?: string } | undefined;
      const shellStatus = [...shellEvents].reverse().find((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; jsonToolFallbackUsed?: boolean } | undefined;
      const shellProgress = shellEvents.filter((event) => event.type === 'progress').map((event) => String(event.data || '')).join('');

      assert.equal(shellToolUse?.name, 'JsonTool:shell');
      assert.equal(shellToolResult?.is_error, false);
      assert.match(shellToolResult?.content || '', /cti-tool-required-ok/);
      assert.equal(shellStatus?.evidenceSatisfied, true);
      assert.equal(shellStatus?.jsonToolFallbackUsed, true);
      assert.doesNotMatch(shellProgress, /处理思路|执行结果|正在组织上下文/);
      assert.match(shellProgress, /准备执行命令/);
      assert.match(shellProgress, /命令执行完成/);
      const shellText = [...shellEvents].reverse().find((event) => event.type === 'text')?.data;
      assert.match(String(shellText || ''), /这个我处理好了/);

      const readEvents = await runProvider({
        sessionId: 'test-session-read',
        prompt: '看一下工作目录',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'local_read_required',
          reason: 'regression requires a concrete local read',
          requiredToolFamilies: ['read'],
        },
      });
      const readToolUse = readEvents.find((event) => event.type === 'tool_use')?.data as { name?: string } | undefined;
      const readToolResult = readEvents.find((event) => event.type === 'tool_result')?.data as { is_error?: boolean; content?: string } | undefined;
      const readStatus = [...readEvents].reverse().find((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; jsonToolFallbackUsed?: boolean } | undefined;
      const readProgress = readEvents.filter((event) => event.type === 'progress').map((event) => String(event.data || '')).join('');

      assert.equal(readToolUse?.name, 'JsonTool:list_dir');
      assert.equal(readToolResult?.is_error, false);
      assert.match(readToolResult?.content || '', /Assets/);
      assert.equal(readStatus?.evidenceSatisfied, true);
      assert.equal(readStatus?.jsonToolFallbackUsed, true);
      assert.match(readProgress, /准备读取目录/);
      assert.doesNotMatch(readProgress, /处理思路|执行结果|正在组织上下文/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes configured Unity MCP actions and returns a model-composed cti-final reply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-mcp-'));
    try {
      const imagePath = path.join(root, 'screenshot.png');
      fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const provider = new CodexLocalCliProvider(makeConfig(root)) as unknown as {
        mcpToolCallDefinitions: unknown[];
        executeValidatedJsonToolRequest: (request: unknown) => Promise<unknown>;
        runCodexExecText: (input: { promptOverride?: string; systemPromptAppend?: string }) => Promise<{ text: string; usage: null }>;
        runJsonToolProtocol: (
          controller: ReadableStreamDefaultController<string>,
          params: Record<string, unknown>,
          model: string,
          baseUrl: string,
        ) => Promise<void>;
      };
      provider.mcpToolCallDefinitions = [{
        id: 'test.unity.screenshot',
        match: { regex: ['(?:unitymcp|unity).*截.*game'] },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }];
      provider.executeValidatedJsonToolRequest = async (request: unknown) => {
        const tool = (request as { tool?: string }).tool;
        assert.equal(tool, 'mcp_call');
        return {
          tool: 'mcp_call',
          ok: true,
          data: {
            server: 'unityMCP',
            tool: 'manage_camera',
            result: JSON.stringify({
              success: true,
              data: {
                path: 'Assets/Screenshots/test.png',
                fullPath: imagePath,
              },
            }),
            durationMs: 10,
          },
        };
      };
      provider.runCodexExecText = async ({ promptOverride }) => {
        assert.match(promptOverride || '', /Final answer composer/);
        return {
          text: '**处理思路**\n- 已调用 Unity 工具截取当前 Game 视图。\n\n**执行结果**\n- 截图已生成。',
          usage: null,
        };
      };

      const chunks: string[] = [];
      const controller = {
        enqueue: (chunk: string) => chunks.push(chunk),
      } as unknown as ReadableStreamDefaultController<string>;
      await provider.runJsonToolProtocol(controller, {
        sessionId: 'test-session-mcp',
        prompt: 'Unitymcp截一个game图',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'tool_required',
          reason: 'request asks for a concrete Unity MCP screenshot',
          requiredToolFamilies: ['unity-mcp', 'mcp'],
        },
      }, 'qwen-test', 'http://127.0.0.1:11434');
      const events = parseSseChunks(chunks);
      const toolUse = events.find((event) => event.type === 'tool_use')?.data as { name?: string; input?: Record<string, unknown> } | undefined;
      const toolResult = events.find((event) => event.type === 'tool_result')?.data as { is_error?: boolean; content?: string } | undefined;
      const status = [...events].reverse().find((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; jsonToolFallbackUsed?: boolean; requestedTool?: string } | undefined;
      const text = events.find((event) => event.type === 'text')?.data as string | undefined;
      const progress = events.filter((event) => event.type === 'progress').map((event) => String(event.data || '')).join('');

      assert.equal(toolUse?.name, 'JsonTool:mcp_call');
      assert.equal(toolUse?.input?.tool, 'manage_camera');
      assert.equal(toolResult?.is_error, false);
      assert.match(toolResult?.content || '', /Assets\/Screenshots\/test\.png/);
      assert.equal(status?.requestedTool, 'mcp_call');
      assert.equal(status?.evidenceSatisfied, true);
      assert.equal(status?.jsonToolFallbackUsed, true);
      assert.match(text || '', /```cti-final/);
      assert.match(text || '', /"kind":"image"/);
      assert.ok((text || '').includes('\u5904\u7406\u601d\u8def'));
      assert.ok((text || '').includes('\u6267\u884c\u7ed3\u679c'));
      assert.match(text || '', /"images":\[/);
      assert.match(text || '', /screenshot\.png/);
      assert.doesNotMatch(progress, /处理思路|执行结果|正在组织上下文/);
      assert.match(progress, /manage_camera/);
      assert.match(progress, /截图|图片|工具/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes configured artifact actions for artifact_required tasks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-artifact-provider-'));
    try {
      const imagePath = path.join(root, 'desktop-latest.png');
      const provider = new CodexLocalCliProvider(makeConfig(root)) as unknown as {
        shellArtifactDefinitions: unknown[];
        runCodexExecText: (input: { promptOverride?: string; systemPromptAppend?: string }) => Promise<{ text: string; usage: null }>;
        runJsonToolProtocol: (
          controller: ReadableStreamDefaultController<string>,
          params: Record<string, unknown>,
          model: string,
          baseUrl: string,
        ) => Promise<void>;
      };
      provider.shellArtifactDefinitions = [{
        id: 'test.desktop.screenshot',
        displayName: 'Desktop Screenshot',
        match: { regex: ['(桌面|屏幕).*(截图|截屏)|(截图|截屏).*(桌面|屏幕)'] },
        command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], Buffer.from([0x89,0x50,0x4e,0x47]))" ${JSON.stringify(imagePath)}`,
        cwd: root,
        timeoutMs: 5000,
        artifactPaths: [imagePath],
      }];
      provider.runCodexExecText = async ({ promptOverride }) => {
        assert.match(promptOverride || '', /Final answer composer/);
        return {
          text: '**处理思路**\n- 已执行桌面截图工具并校验图片文件。\n\n**执行结果**\n- 桌面截图已生成。',
          usage: null,
        };
      };

      const chunks: string[] = [];
      const controller = {
        enqueue: (chunk: string) => chunks.push(chunk),
      } as unknown as ReadableStreamDefaultController<string>;
      await provider.runJsonToolProtocol(controller, {
        sessionId: 'test-session-artifact',
        prompt: '截图一下桌面给我看看',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'artifact_required',
          reason: 'request asks for a local image artifact',
          requiredToolFamilies: ['artifact'],
        },
      }, 'qwen-test', 'http://127.0.0.1:11434');

      const events = parseSseChunks(chunks);
      const toolUse = events.find((event) => event.type === 'tool_use')?.data as { name?: string; input?: Record<string, unknown> } | undefined;
      const toolResult = events.find((event) => event.type === 'tool_result')?.data as { is_error?: boolean; content?: string } | undefined;
      const status = [...events].reverse().find((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; requestedTool?: string; executedTool?: string } | undefined;
      const text = events.find((event) => event.type === 'text')?.data as string | undefined;

      assert.equal(toolUse?.name, 'JsonTool:shell_artifact');
      assert.equal(toolUse?.input?.displayName, 'Desktop Screenshot');
      assert.equal(toolResult?.is_error, false);
      assert.match(toolResult?.content || '', /desktop-latest\.png/);
      assert.equal(status?.requestedTool, 'shell_artifact');
      assert.equal(status?.executedTool, 'shell_artifact');
      assert.equal(status?.evidenceSatisfied, true);
      assert.match(text || '', /```cti-final/);
      assert.match(text || '', /"kind":"image"/);
      assert.match(text || '', /desktop-latest\.png/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the local model plan multiple MCP tool calls from schemas', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-agent-'));
    try {
      const calls: string[] = [];
      const provider = new CodexLocalCliProvider(makeConfig(root)) as unknown as {
        buildMcpToolCatalog: () => Promise<unknown[]>;
        executeValidatedJsonToolRequest: (request: unknown) => Promise<unknown>;
        runCodexExecText: (input: { promptOverride?: string; systemPromptAppend?: string }) => Promise<{ text: string; usage: null }>;
        runJsonToolProtocol: (
          controller: ReadableStreamDefaultController<string>,
          params: Record<string, unknown>,
          model: string,
          baseUrl: string,
        ) => Promise<void>;
      };
      provider.buildMcpToolCatalog = async () => [
        {
          manifestHint: 'unitymcp',
          displayName: 'Unity MCP',
          tool: 'manage_asset',
          description: 'Search Unity assets.',
          inputSchema: { properties: { action: { enum: ['search'] }, path: { type: 'string' }, filter_type: { type: 'string' }, search_pattern: { type: 'string' } } },
        },
        {
          manifestHint: 'unitymcp',
          displayName: 'Unity MCP',
          tool: 'manage_scene',
          description: 'Load or inspect Unity scenes.',
          inputSchema: { properties: { action: { enum: ['load'] }, path: { type: 'string' } } },
        },
      ];
      provider.runCodexExecText = async ({ promptOverride, systemPromptAppend }) => {
        const promptText = [promptOverride, systemPromptAppend].filter(Boolean).join('\n');
        calls.push(systemPromptAppend || '');
        if (promptText.includes('Final answer composer')) {
          return {
            text: '**处理思路**\n- 先搜索场景资源，再用返回的精确路径加载场景。\n\n**执行结果**\n- Loaded scene HSScene.',
            usage: null,
          };
        }
        if ((systemPromptAppend || '').includes('Assets/__Art/HospitalSimulation/ForArtist/HSScene.unity')) {
          return {
            text: JSON.stringify({
              action: 'tool_request',
              tool: 'mcp_call',
              args: {
                manifestHint: 'unitymcp',
                tool: 'manage_scene',
                arguments: { action: 'load', path: 'Assets/__Art/HospitalSimulation/ForArtist/HSScene.unity' },
              },
            }),
            usage: null,
          };
        }
        if (calls.length === 1) {
          assert.match(systemPromptAppend || '', /manage_scene/);
          return {
            text: JSON.stringify({
              action: 'tool_request',
              tool: 'mcp_call',
              args: {
                manifestHint: 'unitymcp',
                tool: 'manage_asset',
                arguments: { action: 'search', path: 'Assets', filter_type: 'Scene', search_pattern: 'hsscene', page_size: 10 },
              },
            }),
            usage: null,
          };
        }
        assert.match(systemPromptAppend || '', /Assets\/__Art\/HospitalSimulation\/ForArtist\/HSScene\.unity/);
        return {
          text: JSON.stringify({
            action: 'tool_request',
            tool: 'mcp_call',
            args: {
              manifestHint: 'unitymcp',
              tool: 'manage_scene',
              arguments: { action: 'load', path: 'Assets/__Art/HospitalSimulation/ForArtist/HSScene.unity' },
            },
          }),
          usage: null,
        };
      };
      provider.executeValidatedJsonToolRequest = async (request: unknown) => {
        const args = (request as { args?: { tool?: string; arguments?: Record<string, unknown> } }).args;
        if (args?.tool === 'manage_asset') {
          return {
            tool: 'mcp_call',
            ok: true,
            data: {
              server: 'unityMCP',
              tool: 'manage_asset',
              result: JSON.stringify({
                success: true,
                data: {
                  assets: [{ path: 'Assets/__Art/HospitalSimulation/ForArtist/HSScene.unity', name: 'HSScene' }],
                },
              }),
              durationMs: 5,
            },
          };
        }
        assert.equal(args?.tool, 'manage_scene');
        assert.equal(args?.arguments?.path, 'Assets/__Art/HospitalSimulation/ForArtist/HSScene.unity');
        return {
          tool: 'mcp_call',
          ok: true,
          data: {
            server: 'unityMCP',
            tool: 'manage_scene',
            result: JSON.stringify({ success: true, message: 'Loaded scene HSScene.' }),
            durationMs: 8,
          },
        };
      };

      const chunks: string[] = [];
      const controller = {
        enqueue: (chunk: string) => chunks.push(chunk),
      } as unknown as ReadableStreamDefaultController<string>;
      await provider.runJsonToolProtocol(controller, {
        sessionId: 'test-session-mcp-agent',
        prompt: 'unitymcp切换hsscene场景',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'tool_required',
          reason: 'request asks for a concrete Unity MCP scene action',
          requiredToolFamilies: ['unity-mcp', 'mcp'],
        },
      }, 'qwen-test', 'http://127.0.0.1:11434');

      const events = parseSseChunks(chunks);
      const toolUses = events.filter((event) => event.type === 'tool_use').map((event) => event.data as { input?: { tool?: string } });
      const toolResults = events.filter((event) => event.type === 'tool_result');
      const text = events.find((event) => event.type === 'text')?.data as string | undefined;
      const progress = events.filter((event) => event.type === 'progress').map((event) => String(event.data || '')).join('');
      assert.deepEqual(toolUses.map((event) => event.input?.tool), ['manage_asset', 'manage_scene']);
      assert.equal(toolResults.length, 2);
      assert.ok((text || '').includes('\u5904\u7406\u601d\u8def'));
      assert.ok((text || '').includes('\u6267\u884c\u7ed3\u679c'));
      assert.match(text || '', /Loaded scene HSScene/);
      assert.doesNotMatch(text || '', /"success":true/);
      assert.doesNotMatch(progress, /处理思路|执行结果|正在组织上下文/);
      assert.match(progress, /manage_asset/);
      assert.match(progress, /manage_scene/);
      assert.match(progress, /继续基于真实返回值规划下一步/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses MCP search schemas directly for web-search requirements', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-web-search-'));
    try {
      const provider = new CodexLocalCliProvider(makeConfig(root)) as unknown as {
        buildMcpToolCatalog: () => Promise<unknown[]>;
        executeValidatedJsonToolRequest: (request: unknown) => Promise<unknown>;
        runCodexExecText: (input: { promptOverride?: string }) => Promise<{ text: string; usage: null }>;
        runJsonToolProtocol: (
          controller: ReadableStreamDefaultController<string>,
          params: Record<string, unknown>,
          model: string,
          baseUrl: string,
        ) => Promise<void>;
      };
      provider.buildMcpToolCatalog = async () => [
        {
          manifestHint: 'mcp-web-search',
          displayName: 'Web Search MCP',
          tool: 'web_search',
          description: 'Search current web pages and news.',
          inputSchema: { properties: { query: { type: 'string' }, pageno: { type: 'number' } } },
        },
      ];
      provider.executeValidatedJsonToolRequest = async (request: unknown) => {
        const args = (request as { args?: { manifestHint?: string; tool?: string; arguments?: Record<string, unknown> } }).args;
        assert.equal(args?.manifestHint, 'mcp-web-search');
        assert.equal(args?.tool, 'web_search');
        assert.equal(args?.arguments?.query, '查一下今天的三个头条');
        return {
          tool: 'mcp_call',
          ok: true,
          data: {
            server: 'mcp-web-search',
            tool: 'web_search',
            args: args?.arguments,
            result: '1. Headline A\n2. Headline B\n3. Headline C',
            durationMs: 12,
          },
        };
      };
      provider.runCodexExecText = async ({ promptOverride }) => {
        assert.match(promptOverride || '', /Final answer composer/);
        return {
          text: '今天三个头条是：Headline A、Headline B、Headline C。',
          usage: null,
        };
      };

      const chunks: string[] = [];
      const controller = {
        enqueue: (chunk: string) => chunks.push(chunk),
      } as unknown as ReadableStreamDefaultController<string>;
      await provider.runJsonToolProtocol(controller, {
        sessionId: 'test-session-web-search',
        prompt: '查一下今天的三个头条',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'tool_required',
          reason: 'request asks for current web information',
          requiredToolFamilies: ['web-search', 'mcp'],
        },
      }, 'qwen-test', 'http://127.0.0.1:11434');

      const events = parseSseChunks(chunks);
      const toolUse = events.find((event) => event.type === 'tool_use')?.data as { name?: string; input?: Record<string, unknown> } | undefined;
      const toolResult = events.find((event) => event.type === 'tool_result')?.data as { is_error?: boolean; content?: string } | undefined;
      const status = [...events].reverse().find((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; requestedTool?: string } | undefined;
      const text = events.find((event) => event.type === 'text')?.data as string | undefined;

      assert.equal(toolUse?.name, 'JsonTool:mcp_call');
      assert.equal(toolUse?.input?.tool, 'web_search');
      assert.equal(toolResult?.is_error, false);
      assert.match(toolResult?.content || '', /Headline A/);
      assert.equal(status?.requestedTool, 'mcp_call');
      assert.equal(status?.evidenceSatisfied, true);
      assert.match(text || '', /```cti-final/);
      assert.match(text || '', /Headline A/);
      const progress = events.filter((event) => event.type === 'progress').map((event) => String(event.data || '')).join('');
      assert.doesNotMatch(progress, /处理思路|执行结果|正在组织上下文/);
      assert.match(progress, /查一下今天的三个头条/);
      assert.match(progress, /web_search/);
      assert.match(progress, /网页|新闻|联网|搜索|结果/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not accept model-composed object names when MCP only returned instance IDs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-id-only-'));
    try {
      const provider = new CodexLocalCliProvider(makeConfig(root)) as unknown as {
        buildMcpToolCatalog: () => Promise<unknown[]>;
        executeValidatedJsonToolRequest: (request: unknown) => Promise<unknown>;
        runCodexExecText: (input: { promptOverride?: string; systemPromptAppend?: string }) => Promise<{ text: string; usage: null }>;
        runJsonToolProtocol: (
          controller: ReadableStreamDefaultController<string>,
          params: Record<string, unknown>,
          model: string,
          baseUrl: string,
        ) => Promise<void>;
      };
      provider.buildMcpToolCatalog = async () => [
        {
          manifestHint: 'unityMCP',
          displayName: 'Unity MCP',
          tool: 'find_gameobjects',
          description: 'Search for GameObjects in the scene by component. Returns instance IDs only.',
          inputSchema: {
            properties: {
              search_term: { type: 'string' },
              search_method: { enum: ['by_component'] },
              include_inactive: { type: 'boolean' },
            },
          },
        },
      ];
      provider.runCodexExecText = async ({ promptOverride, systemPromptAppend }) => {
        const promptText = [promptOverride, systemPromptAppend].filter(Boolean).join('\n');
        if (promptText.includes('Final answer composer')) {
          return {
            text: '在Unity场景里找到了含有相机组件的物体，节点名称是：**Main Camera**。',
            usage: null,
          };
        }
        return {
          text: JSON.stringify({
            action: 'tool_request',
            tool: 'mcp_call',
            args: {
              manifestHint: 'unityMCP',
              tool: 'find_gameobjects',
              arguments: { search_term: 'Camera', search_method: 'by_component', include_inactive: true },
            },
          }),
          usage: null,
        };
      };
      provider.executeValidatedJsonToolRequest = async () => ({
        tool: 'mcp_call',
        ok: true,
        data: {
          server: 'unityMCP',
          tool: 'find_gameobjects',
          args: { search_term: 'Camera', search_method: 'by_component', include_inactive: true },
          result: JSON.stringify({
            success: true,
            message: 'Found GameObjects',
            data: {
              instanceIDs: [149480],
              pageSize: 50,
              cursor: 0,
              nextCursor: null,
              totalCount: 1,
              hasMore: false,
            },
          }),
          durationMs: 50,
        },
      });

      const chunks: string[] = [];
      const controller = {
        enqueue: (chunk: string) => chunks.push(chunk),
      } as unknown as ReadableStreamDefaultController<string>;
      await provider.runJsonToolProtocol(controller, {
        sessionId: 'test-session-id-only',
        prompt: 'unity场景里找有相机组件的物体\n总结成节点名称发我',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'tool_required',
          reason: 'request asks for current Unity scene object names',
          requiredToolFamilies: ['unity-mcp'],
        },
      }, 'qwen-test', 'http://127.0.0.1:11434');

      const events = parseSseChunks(chunks);
      const text = events.find((event) => event.type === 'text')?.data as string | undefined;
      assert.match(text || '', /未完成：/);
      assert.match(text || '', /只返回了对象 ID/);
      assert.doesNotMatch(text || '', /Main Camera/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects shell plans when the execution requirement only allows MCP tools', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-mcp-family-'));
    try {
      const provider = new CodexLocalCliProvider(makeConfig(root)) as unknown as {
        runJsonToolProtocol: (
          controller: ReadableStreamDefaultController<string>,
          params: Record<string, unknown>,
          model: string,
          baseUrl: string,
        ) => Promise<void>;
        runCodexExecText: () => Promise<{ text: string; usage: null }>;
        buildMcpToolCatalog: () => Promise<[]>;
      };
      provider.buildMcpToolCatalog = async () => [];
      provider.runCodexExecText = async () => ({
        text: JSON.stringify({
          action: 'tool_request',
          tool: 'shell',
          args: { command: 'echo should-not-run', cwd: root },
        }),
        usage: null,
      });

      const chunks: string[] = [];
      const controller = {
        enqueue: (chunk: string) => chunks.push(chunk),
      } as unknown as ReadableStreamDefaultController<string>;
      await provider.runJsonToolProtocol(controller, {
        sessionId: 'test-session-mcp-family',
        prompt: 'unitymcp切换hsscene场景',
        workingDirectory: root,
        additionalDirectories: [root],
        permissionMode: 'acceptEdits',
        executionRequirement: {
          kind: 'tool_required',
          reason: 'request asks for an MCP action',
          requiredToolFamilies: ['mcp'],
        },
      }, 'qwen-test', 'http://127.0.0.1:11434');

      const events = parseSseChunks(chunks);
      const toolUses = events.filter((event) => event.type === 'tool_use');
      const text = events.find((event) => event.type === 'text')?.data as string | undefined;
      const progress = events.filter((event) => event.type === 'progress').map((event) => String(event.data || '')).join('');

      assert.equal(toolUses.length, 0);
      assert.match(text || '', /未完成/);
      assert.match(progress, /没有得到可执行工具计划/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
