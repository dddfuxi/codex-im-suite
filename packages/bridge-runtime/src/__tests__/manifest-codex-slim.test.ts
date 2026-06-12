import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildManifestCodexSlimParams } from '../manifest-codex-slim.js';

describe('manifest Codex slim params', () => {
  it('keeps Codex as the executor while replacing broad context with manifest tool boundaries', () => {
    const result = buildManifestCodexSlimParams({
      sessionId: 'test-session',
      prompt: 'unitygame视角截个图',
      systemPrompt: 'very long original system prompt with reply contract',
      conversationHistory: [
        { role: 'user', content: 'old user message' },
        { role: 'assistant', content: 'old assistant message' },
      ],
      workingDirectory: 'C:\\unity\\ST3',
      executionRequirement: { kind: 'none', reason: 'plain chat', requiredToolFamilies: [] },
    }, {
      unityProjectPath: 'C:\\unity\\ST3\\Game',
      allowedWorkspaceRoots: ['C:\\unity\\ST3'],
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot',
        match: { keywordGroups: [['unity', 'game', '截']] },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot', capture_source: 'game_view', include_image: false },
      }],
    });

    assert.equal(result.plan?.request.tool, 'mcp_call');
    assert.equal(result.params.forceFreshThread, true);
    assert.equal(result.params.sdkSessionId, undefined);
    assert.deepEqual(result.params.conversationHistory, []);
    assert.equal(result.params.executionRequirement?.kind, 'tool_required');
    assert.deepEqual(result.params.executionRequirement?.requiredToolFamilies, ['mcp']);
    assert.equal(result.params.executionRequirement?.strictToolEvidence, true);
    assert.match(result.params.systemPrompt || '', /Manifest-constrained Codex task/);
    assert.match(result.params.systemPrompt || '', /manage_camera/);
    assert.match(result.params.systemPrompt || '', /Return only a JSON tool_request object/);
    assert.match(result.params.systemPrompt || '', /Do not read skill files/);
    assert.ok(result.compressedHistoryChars > 0);
  });

  it('leaves normal chat params unchanged when no manifest matches', () => {
    const params = {
      sessionId: 'test-session',
      prompt: '今天状态怎么样',
      systemPrompt: 'normal system prompt',
      conversationHistory: [{ role: 'user' as const, content: 'hello' }],
      executionRequirement: { kind: 'none' as const, reason: 'plain chat', requiredToolFamilies: [] },
    };

    const result = buildManifestCodexSlimParams(params, {
      mcpToolCallDefinitions: [{
        id: 'test.unity.screenshot',
        match: { keywordGroups: [['unity', 'game', '截']] },
        manifestHint: 'unitymcp',
        tool: 'manage_camera',
        arguments: { action: 'screenshot' },
      }],
    });

    assert.equal(result.plan, null);
    assert.equal(result.params, params);
  });
});
