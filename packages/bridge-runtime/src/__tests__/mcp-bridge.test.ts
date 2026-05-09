import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
});
