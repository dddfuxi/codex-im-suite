import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { __internals, MavisClientError } from '../mavis-cli-client.js';

const {
  extractFirstCompleteJson,
  sliceAndParse,
  buildMavisSpawnSpec,
  buildMavisListSessionsArgs,
  buildMavisCreateSessionArgs,
  buildMavisCommunicationMessagesArgs,
  asMavisStatus,
  asTimestampString,
  asBoolean,
} = __internals;

describe('mavis-cli-client JSON extraction', () => {
  it('parses a single object root', () => {
    const result = extractFirstCompleteJson('{"status":"running","port":17321}');
    assert.deepEqual(result, { status: 'running', port: 17321 });
  });

  it('parses an array root and ignores trailing Note', () => {
    const stdout = '[{"agentName":"mavis"},{"agentName":"minimax"}]\nNote: 5 agents available';
    const result = extractFirstCompleteJson(stdout);
    assert.ok(Array.isArray(result));
    assert.equal((result as unknown[]).length, 2);
    assert.equal((result as Array<{ agentName: string }>)[0].agentName, 'mavis');
  });

  it('parses an array whose last object contains a closing brace (NOT lastIndexOf bug)', () => {
    // The pre-v3 lastIndexOf bug would slice to the last `}` and drop the closing `]`,
    // losing the array root. The new extractor must return the full array.
    const stdout = '[{"id":"a","payload":{"k":1}},{"id":"b","payload":{"k":2}}]';
    const result = extractFirstCompleteJson(stdout);
    assert.ok(Array.isArray(result));
    assert.equal((result as Array<{ id: string }>).length, 2);
  });

  it('parses an object even when a prefix line precedes it', () => {
    const stdout = 'mavis daemon 1.0.0\nstatus: ok\n{"status":"running","port":17321}\n';
    const result = extractFirstCompleteJson(stdout);
    assert.deepEqual(result, { status: 'running', port: 17321 });
  });

  it('handles nested objects without losing depth tracking', () => {
    const stdout = '{"a":{"b":{"c":1}},"d":2}';
    const result = extractFirstCompleteJson(stdout);
    assert.deepEqual(result, { a: { b: { c: 1 } }, d: 2 });
  });

  it('handles escaped quotes inside strings', () => {
    const stdout = '{"msg":"hello \\"world\\""}';
    const result = extractFirstCompleteJson(stdout);
    assert.deepEqual(result, { msg: 'hello "world"' });
  });

  it('handles strings containing bracket characters', () => {
    const stdout = '{"prompt":"use [array]","x":1}';
    const result = extractFirstCompleteJson(stdout);
    assert.deepEqual(result, { prompt: 'use [array]', x: 1 });
  });

  it('throws MavisClientError on missing JSON', () => {
    assert.throws(
      () => extractFirstCompleteJson('no json here at all'),
      (err: unknown) => err instanceof MavisClientError && err.message.includes('no_json'),
    );
  });

  it('throws MavisClientError on incomplete JSON', () => {
    assert.throws(
      () => extractFirstCompleteJson('{"status":'),
      (err: unknown) => err instanceof MavisClientError && err.message.includes('json_incomplete'),
    );
  });

  it('throws MavisClientError on unparseable JSON', () => {
    assert.throws(
      () => extractFirstCompleteJson('{"status": broken}'),
      (err: unknown) => err instanceof MavisClientError && err.message.includes('json_parse'),
    );
  });

  it('sliceAndParse keeps depth tracking across deep nesting', () => {
    // Direct sliceAndParse exercise — covers codex second-round blocker ①
    const stdout = '[[[1,2,3]]]';
    const result = sliceAndParse(stdout, 0);
    assert.deepEqual(result, [[[1, 2, 3]]]);
  });
});

describe('mavis-cli-client process spawning', () => {
  it('bypasses simple Windows .cmd shims so multiline prompts stay a single argv value', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-shim-'));
    const shimPath = path.join(tempDir, 'mavis.cmd');
    fs.writeFileSync(
      shimPath,
      [
        '@echo off',
        'chcp 65001 > nul',
        'set ELECTRON_RUN_AS_NODE=1',
        '"F:\\app\\MiniMax Code\\MiniMax Code.exe" "F:\\app\\MiniMax Code\\resources\\resources\\daemon\\cli.js" %*',
        '',
      ].join('\r\n'),
      'utf-8',
    );

    try {
      const spec = buildMavisSpawnSpec(
        shimPath,
        ['session', 'new', '--prompt', 'hello\r\nworld', 'mavis'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      );

      assert.equal(spec.command, 'F:\\app\\MiniMax Code\\MiniMax Code.exe');
      assert.deepEqual(spec.args, [
        'F:\\app\\MiniMax Code\\resources\\resources\\daemon\\cli.js',
        'session',
        'new',
        '--prompt',
        'hello\r\nworld',
        'mavis',
      ]);
      assert.deepEqual(spec.env, { ELECTRON_RUN_AS_NODE: '1' });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to ComSpec for unknown Windows .cmd shims', () => {
    const spec = buildMavisSpawnSpec(
      'C:\\Users\\admin\\.mavis\\bin\\custom.cmd',
      ['status'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    );

    assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(spec.args, ['/d', '/s', '/c', 'C:\\Users\\admin\\.mavis\\bin\\custom.cmd', 'status']);
    assert.equal(spec.displayCommand, 'C:\\Users\\admin\\.mavis\\bin\\custom.cmd status');
  });

  it('keeps normal executables as direct spawn targets', () => {
    const spec = buildMavisSpawnSpec('mavis', ['status'], 'win32', 'C:\\Windows\\System32\\cmd.exe');

    assert.equal(spec.command, 'mavis');
    assert.deepEqual(spec.args, ['status']);
    assert.equal(spec.displayCommand, 'mavis status');
  });
});

describe('mavis-cli-client CLI argument builders', () => {
  it('uses positional agent for session list', () => {
    assert.deepEqual(buildMavisListSessionsArgs('mavis'), ['list', 'mavis']);
    assert.deepEqual(buildMavisListSessionsArgs(), ['list']);
  });

  it('uses positional agent for session new', () => {
    const args = buildMavisCreateSessionArgs({
      agent: 'mavis',
      from: 'root',
      prompt: 'hello',
      title: 'Smoke',
      workspace: 'C:\\work',
      model: 'minimax/MiniMax-M3',
    });

    assert.deepEqual(args, [
      'new',
      '--from',
      'root',
      '--prompt',
      'hello',
      '--title',
      'Smoke',
      '--workspace',
      'C:\\work',
      '--model',
      'minimax/MiniMax-M3',
      'mavis',
    ]);
    assert.equal(args.includes('--agent'), false);
  });

  it('builds communication messages args with directional filters', () => {
    const args = buildMavisCommunicationMessagesArgs({
      from: 'mvs_target',
      to: 'mvs_bridge',
      limit: 20,
      status: 'all',
    });

    assert.deepEqual(args, [
      'messages',
      '--from',
      'mvs_target',
      '--to',
      'mvs_bridge',
      '--limit',
      '20',
      '--status',
      'all',
    ]);
  });
});

describe('mavis-cli-client response normalizers', () => {
  it('reads Mavis session status objects', () => {
    assert.equal(asMavisStatus({ type: 'started' }), 'started');
    assert.equal(asMavisStatus({ type: 'finished' }), 'finished');
    assert.equal(asMavisStatus('aborted'), 'aborted');
    assert.equal(asMavisStatus({}, 'idle'), 'idle');
  });

  it('normalizes millisecond timestamps for polling comparisons', () => {
    const ts = asTimestampString(1782802105622);
    assert.equal(ts, '2026-06-30T06:48:25.622Z');
    assert.equal(Date.parse(ts || ''), 1782802105622);
    assert.equal(asTimestampString('2026-06-30T06:48:25.622Z'), '2026-06-30T06:48:25.622Z');
  });

  it('normalizes compressed/archived flags from Mavis session info', () => {
    assert.equal(asBoolean(true), true);
    assert.equal(asBoolean(false), false);
    assert.equal(asBoolean('true'), true);
    assert.equal(asBoolean('false'), false);
    assert.equal(asBoolean(''), undefined);
  });
});
