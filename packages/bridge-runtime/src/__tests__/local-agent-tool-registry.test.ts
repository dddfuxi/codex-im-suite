import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadLocalAgentToolManifestDiagnostics,
  loadMcpToolCallDefinitions,
} from '../local-agent-tool-registry.js';

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('local agent tool manifest registry', () => {
  it('loads action-manifest/v1 entries from the generic action manifest directory', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-action-manifest-registry-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    const manifestDir = path.join(suiteRoot, 'config', 'action-manifests.d');
    try {
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(manifestDir, 'valid-action.json'), {
        id: 'action.generic.mcp',
        enabled: true,
        type: 'mcp_tool_call',
        compatibility: { protocol: 'action-manifest/v1' },
        match: { keywords: ['generic'] },
        mcp: {
          manifestHint: 'unitymcp',
          tool: 'manage_camera',
          arguments: { action: 'screenshot' },
        },
      });

      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const definitions = loadMcpToolCallDefinitions();

      assert.deepEqual(definitions.map((definition) => definition.id), ['action.generic.mcp']);
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('prefers action manifests over legacy local-agent tool manifests with the same id', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-action-manifest-precedence-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    try {
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(suiteRoot, 'config', 'action-manifests.d', 'new.json'), {
        id: 'action.duplicate',
        enabled: true,
        type: 'mcp_tool_call',
        compatibility: { protocol: 'action-manifest/v1' },
        match: { keywords: ['duplicate'] },
        mcp: {
          manifestHint: 'new-mcp',
          tool: 'new_tool',
        },
      });
      writeJson(path.join(suiteRoot, 'config', 'local-agent-tools.d', 'legacy.json'), {
        id: 'action.duplicate',
        enabled: true,
        type: 'mcp_tool_call',
        match: { keywords: ['duplicate'] },
        mcp: {
          manifestHint: 'legacy-mcp',
          tool: 'legacy_tool',
        },
      });

      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const definitions = loadMcpToolCallDefinitions();
      const diagnostics = loadLocalAgentToolManifestDiagnostics();

      assert.equal(definitions.length, 1);
      assert.equal(definitions[0]?.manifestHint, 'new-mcp');
      assert.ok(diagnostics.some((item) => /duplicate action manifest id/i.test(item.message)));
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('lets user overlay action manifests override bundled action manifests with the same id', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-action-manifest-overlay-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    try {
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(suiteRoot, 'config', 'action-manifests.d', 'bundled.json'), {
        id: 'action.override',
        enabled: true,
        type: 'mcp_tool_call',
        compatibility: { protocol: 'action-manifest/v1' },
        match: { keywords: ['override'] },
        mcp: {
          manifestHint: 'bundled-mcp',
          tool: 'bundled_tool',
        },
      });
      writeJson(path.join(ctiHome, 'extensions', 'manifests', 'action-manifests.d', 'overlay.json'), {
        id: 'action.override',
        enabled: true,
        type: 'mcp_tool_call',
        compatibility: { protocol: 'action-manifest/v1' },
        match: { keywords: ['override'] },
        mcp: {
          manifestHint: 'overlay-mcp',
          tool: 'overlay_tool',
        },
      });

      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const definitions = loadMcpToolCallDefinitions();
      const diagnostics = loadLocalAgentToolManifestDiagnostics();

      assert.equal(definitions.length, 1);
      assert.equal(definitions[0]?.manifestHint, 'overlay-mcp');
      assert.ok(diagnostics.some((item) => /overrides previous action manifest id/i.test(item.message)));
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports invalid tool action manifests without dropping valid definitions silently', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-tool-registry-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    const manifestDir = path.join(suiteRoot, 'config', 'local-agent-tools.d');
    try {
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(manifestDir, 'valid.json'), {
        id: 'valid.mcp.action',
        enabled: true,
        type: 'mcp_tool_call',
        match: { keywords: ['valid'] },
        mcp: {
          manifestHint: 'unitymcp',
          tool: 'manage_camera',
          arguments: { action: 'screenshot' },
        },
      });
      fs.writeFileSync(path.join(manifestDir, 'broken.json'), '{ bad json', 'utf8');
      writeJson(path.join(manifestDir, 'incomplete.json'), {
        id: 'incomplete.action',
        enabled: true,
        type: 'mcp_tool_call',
        mcp: { manifestHint: 'unitymcp' },
      });

      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const definitions = loadMcpToolCallDefinitions();
      const diagnostics = loadLocalAgentToolManifestDiagnostics();

      assert.deepEqual(definitions.map((definition) => definition.id), ['valid.mcp.action']);
      assert.equal(diagnostics.length, 2);
      assert.ok(diagnostics.some((item) => item.filePath.endsWith('broken.json') && /JSON parse failed/.test(item.message)));
      assert.ok(diagnostics.some((item) => item.filePath.endsWith('incomplete.json') && /mcp\.tool/.test(item.message)));
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports invalid regex patterns in action manifests before matching', () => {
    const previousSuiteRoot = process.env.CODEX_IM_SUITE_ROOT;
    const previousCtiHome = process.env.CTI_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-action-manifest-regex-'));
    const suiteRoot = path.join(tempRoot, 'suite');
    const ctiHome = path.join(tempRoot, 'cti-home');
    try {
      writeJson(path.join(suiteRoot, 'suite.manifest.json'), { name: 'suite' });
      writeJson(path.join(suiteRoot, 'config', 'action-manifests.d', 'bad-regex.json'), {
        id: 'action.bad_regex',
        enabled: true,
        type: 'mcp_tool_call',
        compatibility: { protocol: 'action-manifest/v1' },
        match: { regex: ['['] },
        mcp: {
          manifestHint: 'unitymcp',
          tool: 'manage_camera',
        },
      });

      process.env.CODEX_IM_SUITE_ROOT = suiteRoot;
      process.env.CTI_HOME = ctiHome;

      const definitions = loadMcpToolCallDefinitions();
      const diagnostics = loadLocalAgentToolManifestDiagnostics();

      assert.deepEqual(definitions.map((definition) => definition.id), []);
      assert.ok(diagnostics.some((item) => /invalid match\.regex regex/.test(item.message)));
    } finally {
      if (previousSuiteRoot === undefined) delete process.env.CODEX_IM_SUITE_ROOT;
      else process.env.CODEX_IM_SUITE_ROOT = previousSuiteRoot;
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
