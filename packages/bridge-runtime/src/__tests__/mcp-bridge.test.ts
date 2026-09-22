import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Config } from '../config.js';
import { McpBridge } from '../mcp-bridge.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  allowedWorkspaceRoots: [process.cwd()],
};

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function withFakeMcpHttpServer(resourceText: string, run: (url: string, calls: { resourceReads: number }) => Promise<void>) {
  const calls = { resourceReads: 0 };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) as { id?: string | number; method?: string } : {};
      response.setHeader('Content-Type', 'application/json');
      if (payload.method === 'initialize') {
        response.setHeader('mcp-session-id', 'test-session');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
          },
        }));
        return;
      }
      if (payload.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end('');
        return;
      }
      if (payload.method === 'resources/read') {
        calls.resourceReads += 1;
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            contents: [{ uri: 'mcpforunity://instances', text: resourceText }],
          },
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unknown method' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/mcp`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withFakeToolMcpHttpServer(run: (url: string, calls: { initializes: number; toolLists: number; toolCalls: number }) => Promise<void>) {
  const calls = { initializes: 0, toolLists: 0, toolCalls: 0 };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } : {};
      response.setHeader('Content-Type', 'application/json');
      if (payload.method === 'initialize') {
        calls.initializes += 1;
        response.setHeader('mcp-session-id', 'cached-session');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake-tool-mcp', version: '1.0.0' },
          },
        }));
        return;
      }
      if (payload.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end('');
        return;
      }
      if (payload.method === 'tools/list') {
        calls.toolLists += 1;
        assert.equal(request.headers['mcp-session-id'], 'cached-session');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            tools: [{ name: 'demo_tool', description: 'Demo tool', inputSchema: { type: 'object' } }],
          },
        }));
        return;
      }
      if (payload.method === 'tools/call') {
        calls.toolCalls += 1;
        assert.equal(request.headers['mcp-session-id'], 'cached-session');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            content: [{ type: 'text', text: `called ${payload.params?.name || ''}` }],
          },
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unknown method' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/mcp`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withFakeUnityMcpHttpServer(
  options: { resourceText: string; dataPath: string },
  run: (url: string, calls: { resourceReads: number; toolCalls: number }) => Promise<void>,
) {
  const calls = { resourceReads: 0, toolCalls: 0 };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) as {
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      } : {};
      response.setHeader('Content-Type', 'application/json');
      if (payload.method === 'initialize') {
        response.setHeader('mcp-session-id', 'unity-session');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake-unity-mcp', version: '1.0.0' },
          },
        }));
        return;
      }
      if (payload.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end('');
        return;
      }
      if (payload.method === 'tools/list') {
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            tools: [{ name: 'manage_camera', description: 'Camera tools' }],
          },
        }));
        return;
      }
      if (payload.method === 'resources/read') {
        calls.resourceReads += 1;
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            contents: [{ uri: 'mcpforunity://instances', text: options.resourceText }],
          },
        }));
        return;
      }
      if (payload.method === 'tools/call') {
        calls.toolCalls += 1;
        if (payload.params?.name === 'execute_code') {
          response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Code executed successfully.',
                  data: { result: options.dataPath, compiler: 'roslyn' },
                }),
              }],
            },
          }));
          return;
        }
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'screenshot captured' }) }],
          },
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unknown method' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/mcp`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('McpBridge manifest discovery', () => {
  it('projects only enabled workspace-valid manifests into isolated Codex MCP config', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-codex-projection-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    const unityProject = path.join(tempRoot, 'unity-project');
    try {
      fs.mkdirSync(unityProject, { recursive: true });
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(suiteRoot, 'config', 'mcp.d', 'unity.json'), {
        id: 'unityMCP',
        displayName: 'Unity MCP',
        type: 'http',
        enabled: true,
        cwd: '${CTI_UNITY_PROJECT_PATH}',
        healthCheck: { url: 'http://127.0.0.1:8081/mcp' },
      });
      writeJson(path.join(suiteRoot, 'config', 'mcp.d', 'disabled.json'), {
        id: 'disabledMcp',
        type: 'http',
        enabled: false,
        cwd: '${CTI_UNITY_PROJECT_PATH}',
        healthCheck: { url: 'http://127.0.0.1:9090/mcp' },
      });
      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const projections = new McpBridge({
        ...baseConfig,
        defaultWorkDir: unityProject,
        allowedWorkspaceRoots: [tempRoot],
        unityProjectPath: unityProject,
      }).listCodexServerProjections();

      assert.deepEqual(projections, [{
        manifestId: 'unityMCP',
        name: 'unityMCP',
        type: 'http',
        url: 'http://127.0.0.1:8081/mcp',
      }]);
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('loads bundled suite manifests and user overlay manifests', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-manifests-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    try {
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(suiteRoot, 'config', 'mcp.d', 'bundled.json'), {
        id: 'bundledMcp',
        displayName: 'Bundled MCP',
        type: 'stdio',
        enabled: true,
      });
      writeJson(path.join(ctiHome, 'extensions', 'manifests', 'mcp.d', 'user.json'), {
        id: 'userMcp',
        displayName: 'User MCP',
        type: 'stdio',
        enabled: true,
      });

      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const manifests = new McpBridge(baseConfig).listManifests();

      assert.deepEqual(
        manifests.map((manifest) => manifest.id).sort(),
        ['bundledMcp', 'userMcp'],
      );
      assert.ok(manifests.find((manifest) => manifest.id === 'userMcp')?.manifestPath.includes('extensions'));
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves Fetch MCP from user overlay aliases and display name', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-fetch-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    try {
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(ctiHome, 'extensions', 'manifests', 'mcp.d', 'mcp-fetch.json'), {
        id: 'mcp-fetch',
        displayName: 'Fetch MCP',
        type: 'stdio',
        enabled: true,
        aliases: ['mcp-fetch', 'fetch mcp', '网页抓取 MCP'],
        registerName: 'mcp-fetch',
        healthCheck: { kind: 'codex-mcp-list' },
      });

      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const bridge = new McpBridge(baseConfig);

      assert.equal(bridge.resolveManifestFromPrompt('Fetch MCP能用吗')?.id, 'mcp-fetch');
      assert.equal(bridge.resolveManifestFromPrompt('网页抓取 MCP 状态')?.id, 'mcp-fetch');
      assert.deepEqual(bridge.listAvailableManifestNames(), ['Fetch MCP']);
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports codex-registered stdio MCP as registered but pending handshake', async () => {
    if (process.platform !== 'win32') return;
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousPath = process.env.PATH;
    const previousPathWindows = process.env.Path;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-codex-list-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const binDir = path.join(tempRoot, 'bin');
    try {
      fs.mkdirSync(binDir, { recursive: true });
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\necho mcp-fetch enabled stdio\r\n', 'utf8');
      const mergedPath = `${binDir}${path.delimiter}${previousPath || ''}`;
      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.PATH = mergedPath;
      process.env.Path = mergedPath;

      const health = await new McpBridge(baseConfig).checkHealth({
        id: 'mcp-fetch',
        displayName: 'Fetch MCP',
        type: 'stdio',
        cwd: process.cwd(),
        registerName: 'mcp-fetch',
        healthCheck: { kind: 'codex-mcp-list' },
        manifestPath: path.join(suiteRoot, 'config', 'mcp.d', 'mcp-fetch.json'),
      });

      assert.equal(health.ok, true);
      assert.match(health.message, /已注册到 Codex，待 Codex 会话握手时加载/);
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPathWindows === undefined) delete process.env.Path;
      else process.env.Path = previousPathWindows;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows user-installed MCP cwd under CTI_HOME extensions', async () => {
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-cwd-'));
    const ctiHome = path.join(tempRoot, 'cti-home');
    try {
      const cwd = path.join(ctiHome, 'extensions', 'packages', 'mcp', 'demo', '1.0.0');
      fs.mkdirSync(cwd, { recursive: true });
      process.env.CTI_HOME = ctiHome;

      const health = await new McpBridge(baseConfig).checkHealth({
        id: 'userMcp',
        type: 'stdio',
        cwd: '${CTI_HOME}\\extensions\\packages\\mcp\\demo\\1.0.0',
        manifestPath: path.join(ctiHome, 'extensions', 'manifests', 'mcp.d', 'user.json'),
      });

      assert.doesNotMatch(health.message, /工作目录不在当前默认工作区/);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects MCP manifests that do not declare cwd', async () => {
    const health = await new McpBridge(baseConfig).checkHealth({
      id: 'missing-cwd',
      displayName: 'Missing Cwd MCP',
      type: 'stdio',
      registerName: 'missing-cwd',
      healthCheck: { kind: 'codex-mcp-list' },
      manifestPath: 'missing-cwd.json',
    });

    assert.equal(health.ok, false);
    assert.match(health.message, /manifest 未声明 cwd/);
  });

  it('lists and calls stdio MCP tools from a user overlay launcher', async () => {
    if (process.platform !== 'win32') return;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-stdio-'));
    const ctiHome = path.join(tempRoot, 'cti-home');
    try {
      const launcher = path.join(ctiHome, 'extensions', 'launchers', 'fake-search.ps1');
      const cwd = path.join(ctiHome, 'extensions', 'packages', 'mcp', 'fake-search', '1.0.0');
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(launcher, [
        "$ErrorActionPreference = 'Stop'",
        "while (($line = [Console]::In.ReadLine()) -ne $null) {",
        "  if (-not $line.Trim()) { continue }",
        "  $msg = $line | ConvertFrom-Json",
        "  if ($msg.method -eq 'notifications/initialized') { continue }",
        "  $id = $msg.id",
        "  if ($msg.method -eq 'initialize') {",
        "    $result = @{ protocolVersion = '2024-11-05'; capabilities = @{}; serverInfo = @{ name = 'fake-search'; version = '1.0.0' } }",
        "  } elseif ($msg.method -eq 'tools/list') {",
        "    $result = @{ tools = @(@{ name = 'web_search'; description = 'Search the web'; inputSchema = @{ type = 'object'; properties = @{ query = @{ type = 'string' } } } }) }",
        "  } elseif ($msg.method -eq 'tools/call') {",
        "    $query = [string]$msg.params.arguments.query",
        "    $result = @{ content = @(@{ type = 'text'; text = \"searched: $query\" }) }",
        "  } else {",
        "    $result = @{}",
        "  }",
        "  $response = @{ jsonrpc = '2.0'; id = $id; result = $result } | ConvertTo-Json -Depth 20 -Compress",
        "  [Console]::Out.WriteLine($response)",
        "  [Console]::Out.Flush()",
        "}",
      ].join('\r\n'), 'utf8');
      process.env.CTI_HOME = ctiHome;

      const bridge = new McpBridge(baseConfig);
      const manifest = {
        id: 'fake-search',
        displayName: 'Fake Search MCP',
        type: 'stdio' as const,
        launcher,
        cwd: '${CTI_HOME}\\extensions\\packages\\mcp\\fake-search\\1.0.0',
        env: {},
        manifestPath: path.join(ctiHome, 'extensions', 'manifests', 'mcp.d', 'fake-search.json'),
      };

      const tools = await bridge.listToolDetails(manifest);
      assert.deepEqual(tools.map((tool) => tool.name), ['web_search']);

      const result = await bridge.callTool(manifest, 'web_search', { query: 'today headlines' });
      assert.equal(result.ok, true);
      assert.match(result.content, /searched: today headlines/);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves stdio MCP isError as a failed tool call', async () => {
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-'));
    const ctiHome = path.join(tempRoot, 'home');
    const packageDir = path.join(ctiHome, 'extensions', 'packages', 'mcp', 'fake-search', '1.0.0');
    fs.mkdirSync(packageDir, { recursive: true });
    const launcher = path.join(packageDir, 'fake-mcp.ps1');
    try {
      fs.writeFileSync(launcher, [
        "$ErrorActionPreference = 'Stop'",
        "while ($line = [Console]::In.ReadLine()) {",
        "  if (-not $line.Trim()) { continue }",
        "  $msg = $line | ConvertFrom-Json",
        "  $id = $msg.id",
        "  if ($msg.method -eq 'initialize') {",
        "    $result = @{ protocolVersion = '2024-11-05'; capabilities = @{}; serverInfo = @{ name = 'fake'; version = '1.0.0' } }",
        "  } elseif ($msg.method -eq 'tools/call') {",
        "    $result = @{ isError = $true; content = @(@{ type = 'text'; text = 'backend unavailable' }) }",
        "  } else {",
        "    $result = @{}",
        "  }",
        "  $response = @{ jsonrpc = '2.0'; id = $id; result = $result } | ConvertTo-Json -Depth 20 -Compress",
        "  [Console]::Out.WriteLine($response)",
        "  [Console]::Out.Flush()",
        "}",
      ].join('\r\n'), 'utf8');
      process.env.CTI_HOME = ctiHome;

      const bridge = new McpBridge(baseConfig);
      const manifest = {
        id: 'fake-search',
        displayName: 'Fake Search MCP',
        type: 'stdio' as const,
        launcher,
        cwd: '${CTI_HOME}\\extensions\\packages\\mcp\\fake-search\\1.0.0',
        env: {},
        manifestPath: path.join(ctiHome, 'extensions', 'manifests', 'mcp.d', 'fake-search.json'),
      };

      const result = await bridge.callTool(manifest, 'web_search', { query: 'today headlines' });
      assert.equal(result.ok, false);
      assert.match(result.content, /backend unavailable/);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('requires configured MCP resource success evidence for HTTP health', async () => {
    await withFakeUnityMcpHttpServer({
      resourceText: '{"success":true,"instance_count":1,"instances":[{"name":"Editor@abcd"}]}',
      dataPath: path.join(process.cwd(), 'Assets'),
    }, async (url) => {
      const health = await new McpBridge(baseConfig).checkHealth({
        id: 'unityMCP',
        displayName: 'Unity MCP',
        type: 'http',
        cwd: process.cwd(),
        healthCheck: {
          kind: 'mcp-http-resource',
          url,
          resourceUri: 'mcpforunity://instances',
          successRegex: '\\\\?"instance_count\\\\?"\\s*:\\s*[1-9][0-9]*',
          failureRegex: '\\\\?"instance_count\\\\?"\\s*:\\s*0',
        },
        manifestPath: 'unity-mcp.json',
      });

      assert.equal(health.ok, true);
      assert.match(health.message, /MCP resource 健康检查通过/);
    });
  });

  it('does not mark HTTP MCP healthy when the configured resource reports no session', async () => {
    await withFakeMcpHttpServer('{"success":true,"instance_count":0,"instances":[]}', async (url) => {
      const health = await new McpBridge(baseConfig).checkHealth({
        id: 'unityMCP',
        displayName: 'Unity MCP',
        type: 'http',
        cwd: process.cwd(),
        healthCheck: {
          kind: 'mcp-http-resource',
          url,
          resourceUri: 'mcpforunity://instances',
          successRegex: '\\\\?"instance_count\\\\?"\\s*:\\s*[1-9][0-9]*',
          failureRegex: '\\\\?"instance_count\\\\?"\\s*:\\s*0',
        },
        manifestPath: 'unity-mcp.json',
      });

      assert.equal(health.ok, false);
      assert.match(health.message, /资源健康检查未通过/);
    });
  });

  it('does not infer Unity resource checks from manifest identity alone', async () => {
    await withFakeMcpHttpServer('{"success":true,"instance_count":0,"instances":[]}', async (url, calls) => {
      const health = await new McpBridge(baseConfig).checkHealth({
        id: 'unityMCP',
        displayName: 'Unity MCP',
        type: 'http',
        cwd: process.cwd(),
        healthCheck: { kind: 'http', url },
        manifestPath: 'unity-mcp.json',
      });

      assert.equal(health.ok, true);
      assert.equal(calls.resourceReads, 0);
      assert.doesNotMatch(health.message, /instance_count|mcpforunity:\/\/instances/);
    });
  });

  it('rejects a Unity MCP manifest whose cwd does not exist', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-missing-cwd-'));
    try {
      const missingProject = path.join(tempRoot, 'MissingProject');
      const health = await new McpBridge({ ...baseConfig, defaultWorkDir: tempRoot, allowedWorkspaceRoots: [tempRoot] }).checkHealth({
        id: 'unityMCP',
        displayName: 'Unity MCP',
        type: 'http',
        cwd: missingProject,
        healthCheck: {
          kind: 'mcp-http-resource',
          url: 'http://127.0.0.1:9/mcp',
          resourceUri: 'mcpforunity://instances',
        },
        manifestPath: 'unity-mcp.json',
      });

      assert.equal(health.ok, false);
      assert.match(health.message, /MCP 工作目录不存在/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails Unity MCP health when the connected editor project differs from manifest cwd', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-unity-mismatch-'));
    try {
      const configuredProject = path.join(tempRoot, 'ConfiguredGame');
      fs.mkdirSync(configuredProject, { recursive: true });
      const actualDataPath = path.join(tempRoot, 'OtherGame', 'Assets');
      await withFakeUnityMcpHttpServer({
        resourceText: '{"success":true,"instance_count":1,"instances":[{"name":"OtherGame"}]}',
        dataPath: actualDataPath,
      }, async (url) => {
        const health = await new McpBridge({
          ...baseConfig,
          defaultWorkDir: tempRoot,
          allowedWorkspaceRoots: [tempRoot],
          unityProjectPath: configuredProject,
        }).checkHealth({
          id: 'unityMCP',
          displayName: 'Unity MCP',
          type: 'http',
          cwd: configuredProject,
          healthCheck: {
            kind: 'mcp-http-resource',
            url,
            resourceUri: 'mcpforunity://instances',
            successRegex: '\\\\?"instance_count\\\\?"\\s*:\\s*[1-9][0-9]*',
            failureRegex: '\\\\?"instance_count\\\\?"\\s*:\\s*0',
          },
          manifestPath: 'unity-mcp.json',
        });

        assert.equal(health.ok, false);
        assert.match(health.message, /Unity MCP 当前连接项目/);
        assert.match(health.message, /ConfiguredGame/);
        assert.match(health.message, /OtherGame/);
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects Unity MCP tool calls against a different connected editor project', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-unity-call-mismatch-'));
    try {
      const configuredProject = path.join(tempRoot, 'ConfiguredGame');
      fs.mkdirSync(configuredProject, { recursive: true });
      const actualDataPath = path.join(tempRoot, 'OtherGame', 'Assets');
      await withFakeUnityMcpHttpServer({
        resourceText: '{"success":true,"instance_count":1,"instances":[{"name":"OtherGame"}]}',
        dataPath: actualDataPath,
      }, async (url) => {
        const bridge = new McpBridge({
          ...baseConfig,
          defaultWorkDir: tempRoot,
          allowedWorkspaceRoots: [tempRoot],
          unityProjectPath: configuredProject,
        });
        await assert.rejects(
          () => bridge.callTool({
            id: 'unityMCP',
            displayName: 'Unity MCP',
            type: 'http',
            cwd: configuredProject,
            healthCheck: { kind: 'mcp-http-resource', url, resourceUri: 'mcpforunity://instances' },
            manifestPath: 'unity-mcp.json',
          }, 'manage_camera', { action: 'screenshot' }),
          /Unity MCP 当前连接项目/,
        );
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects Unity MCP tool discovery against a different connected editor project', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mcp-unity-list-mismatch-'));
    try {
      const configuredProject = path.join(tempRoot, 'ConfiguredGame');
      fs.mkdirSync(configuredProject, { recursive: true });
      const actualDataPath = path.join(tempRoot, 'OtherGame', 'Assets');
      await withFakeUnityMcpHttpServer({
        resourceText: '{"success":true,"instance_count":1,"instances":[{"name":"OtherGame"}]}',
        dataPath: actualDataPath,
      }, async (url) => {
        const bridge = new McpBridge({
          ...baseConfig,
          defaultWorkDir: tempRoot,
          allowedWorkspaceRoots: [tempRoot],
          unityProjectPath: configuredProject,
        });
        await assert.rejects(
          () => bridge.listToolDetails({
            id: 'unityMCP',
            displayName: 'Unity MCP',
            type: 'http',
            cwd: configuredProject,
            healthCheck: { kind: 'mcp-http-resource', url, resourceUri: 'mcpforunity://instances' },
            manifestPath: 'unity-mcp.json',
          }),
          /Unity MCP 当前连接项目/,
        );
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reuses HTTP MCP sessions and caches tools/list discovery briefly', async () => {
    await withFakeToolMcpHttpServer(async (url, calls) => {
      const bridge = new McpBridge(baseConfig);
      const manifest = {
        id: 'fake-http-tool',
        displayName: 'Fake HTTP Tool MCP',
        type: 'http' as const,
        cwd: process.cwd(),
        healthCheck: { kind: 'http', url },
        manifestPath: 'fake-http-tool.json',
      };

      const firstTools = await bridge.listToolDetails(manifest);
      const secondTools = await bridge.listToolDetails(manifest);
      const result = await bridge.callTool(manifest, 'demo_tool', { value: 1 });

      assert.deepEqual(firstTools.map((tool) => tool.name), ['demo_tool']);
      assert.deepEqual(secondTools.map((tool) => tool.name), ['demo_tool']);
      assert.equal(result.ok, true);
      assert.match(result.content, /called demo_tool/);
      assert.equal(calls.initializes, 1);
      assert.equal(calls.toolLists, 1);
      assert.equal(calls.toolCalls, 1);
    });
  });
});
