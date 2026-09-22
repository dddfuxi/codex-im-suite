import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  registerProviderOutputArtifacts,
  resolveIgnisArtifactDirectoryForTurn,
} from '../local-agent-provider.js';

test('resolves Ignis downloads inside the current turn artifact directory', () => {
  const requested: unknown[] = [];
  const turnStorage = {
    getArtifactDirectory: (scope: unknown) => {
      requested.push(scope);
      return 'C:\\runtime\\artifacts\\session-1\\turn-1';
    },
  } as any;

  assert.equal(
    resolveIgnisArtifactDirectoryForTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      artifactDirectory: 'C:\\runtime\\artifacts\\session-1\\turn-1',
    }, turnStorage),
    path.resolve('C:\\runtime\\artifacts\\session-1\\turn-1', 'ignis'),
  );
  assert.deepEqual(requested, []);

  assert.equal(
    resolveIgnisArtifactDirectoryForTurn({ sessionId: 'session-1', turnId: 'turn-1' }, turnStorage),
    path.resolve('C:\\runtime\\artifacts\\session-1\\turn-1', 'ignis'),
  );
  assert.deepEqual(requested, [{ sessionId: 'session-1', turnId: 'turn-1' }]);
});

test('registers provider output files with the current session and turn identity', () => {
  const calls: unknown[] = [];
  const ids = registerProviderOutputArtifacts({
    registerArtifacts: (input: unknown) => {
      calls.push(input);
      return [{ id: 'artifact-111111111111111111111111' }];
    },
  } as any, {
    sessionId: 'session-1',
    turnId: 'turn-1',
  }, ['C:\\runtime\\artifacts\\session-1\\turn-1\\ignis\\preview.png'], 'ignis');

  assert.deepEqual(ids, ['artifact-111111111111111111111111']);
  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    turnId: 'turn-1',
    files: [{ filePath: 'C:\\runtime\\artifacts\\session-1\\turn-1\\ignis\\preview.png' }],
    source: { kind: 'provider_output', toolName: 'ignis' },
  }]);
});
