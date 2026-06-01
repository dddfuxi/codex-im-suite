import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CodexLocalCliProvider } from '../codex-local-cli-provider.js';
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
  it('executes deterministic runtime tool requests and lets the model compose the final reply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-json-tool-provider-'));
    try {
      fs.mkdirSync(path.join(root, 'Assets'));
      const provider = new CodexLocalCliProvider(makeConfig(root));
      (provider as unknown as { runCodexExecText: (input: { promptOverride?: string; systemPromptAppend?: string }) => Promise<{ text: string; usage: null }> }).runCodexExecText = async ({ promptOverride }) => {
        assert.match(promptOverride || '', /Final answer composer/);
        return {
          text: '**处理思路**\n- 已根据真实工具结果整理回复。\n\n**执行结果**\n- 已完成。',
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
      });

      const shellToolUse = shellEvents.find((event) => event.type === 'tool_use')?.data as { name?: string } | undefined;
      const shellToolResult = shellEvents.find((event) => event.type === 'tool_result')?.data as { is_error?: boolean; content?: string } | undefined;
      const shellStatus = shellEvents.findLast((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; jsonToolFallbackUsed?: boolean } | undefined;

      assert.equal(shellToolUse?.name, 'JsonTool:shell');
      assert.equal(shellToolResult?.is_error, false);
      assert.match(shellToolResult?.content || '', /cti-tool-required-ok/);
      assert.equal(shellStatus?.evidenceSatisfied, true);
      assert.equal(shellStatus?.jsonToolFallbackUsed, true);

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
      const readStatus = readEvents.findLast((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; jsonToolFallbackUsed?: boolean } | undefined;

      assert.equal(readToolUse?.name, 'JsonTool:list_dir');
      assert.equal(readToolResult?.is_error, false);
      assert.match(readToolResult?.content || '', /Assets/);
      assert.equal(readStatus?.evidenceSatisfied, true);
      assert.equal(readStatus?.jsonToolFallbackUsed, true);
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
      const status = events.findLast((event) => event.type === 'status')?.data as { evidenceSatisfied?: boolean; jsonToolFallbackUsed?: boolean; requestedTool?: string } | undefined;
      const text = events.find((event) => event.type === 'text')?.data as string | undefined;

      assert.equal(toolUse?.name, 'JsonTool:mcp_call');
      assert.equal(toolUse?.input?.tool, 'manage_camera');
      assert.equal(toolResult?.is_error, false);
      assert.match(toolResult?.content || '', /Assets\/Screenshots\/test\.png/);
      assert.equal(status?.requestedTool, 'mcp_call');
      assert.equal(status?.evidenceSatisfied, true);
      assert.equal(status?.jsonToolFallbackUsed, true);
      assert.match(text || '', /```cti-final/);
      assert.match(text || '', /"kind":"image"/);
      assert.match(text || '', /处理思路/);
      assert.match(text || '', /"images":\[/);
      assert.match(text || '', /screenshot\.png/);
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
      assert.deepEqual(toolUses.map((event) => event.input?.tool), ['manage_asset', 'manage_scene']);
      assert.equal(toolResults.length, 2);
      assert.match(text || '', /```cti-final/);
      assert.match(text || '', /处理思路/);
      assert.match(text || '', /Loaded scene HSScene/);
      assert.doesNotMatch(text || '', /"success":true/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
