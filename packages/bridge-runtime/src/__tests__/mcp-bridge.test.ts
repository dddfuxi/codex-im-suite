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

describe('McpBridge manifest discovery', () => {
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
    await withFakeMcpHttpServer('{"success":true,"instance_count":1,"instances":[{"name":"Editor@abcd"}]}', async (url) => {
      const health = await new McpBridge(baseConfig).checkHealth({
        id: 'unityMCP',
        displayName: 'Unity MCP',
        type: 'http',
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
        healthCheck: { kind: 'http', url },
        manifestPath: 'unity-mcp.json',
      });

      assert.equal(health.ok, true);
      assert.equal(calls.resourceReads, 0);
      assert.doesNotMatch(health.message, /instance_count|mcpforunity:\/\/instances/);
    });
  });
});
