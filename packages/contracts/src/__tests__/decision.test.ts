import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DECISION_REQUEST_PROTOCOL,
  DECISION_RESULT_PROTOCOL,
  DECISION_VIEW_PROTOCOL,
  type DecisionRequestContract,
  type DecisionResultContract,
  type DecisionViewContract,
} from '../decision.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('decision contracts', () => {
  it('models a Jev-compatible decision without exposing HTTP fields', () => {
    const request: DecisionRequestContract = {
      protocol: DECISION_REQUEST_PROTOCOL,
      requestId: 'decision-request-1',
      state: '用户询问是否应进入人工确认。',
      questions: [{
        id: 'needs_confirmation',
        type: 'noul',
        instructions: '是否需要人工确认？',
        criteria: [],
      }],
      evidenceRefs: ['turn:message-1'],
      requestedAt: '2026-09-22T01:00:00.000Z',
    };
    const result: DecisionResultContract = {
      protocol: DECISION_RESULT_PROTOCOL,
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      answers: [{
        id: 'needs_confirmation',
        type: 'noul',
        noul: 0.82,
        probabilities: { yes: 0.82, no: 0.18 },
      }],
      requestId: request.requestId,
      generatedAt: '2026-09-22T01:00:01.000Z',
    };
    const view: DecisionViewContract = {
      protocol: DECISION_VIEW_PROTOCOL,
      title: '结构化判断',
      state: request.state,
      providerKind: 'noul',
      questions: request.questions,
      result,
    };

    assert.equal(view.result.answers[0]?.noul, 0.82);
    assert.equal(view.result.provider, 'jev');
    assert.equal(view.providerKind, 'noul');
    assert.equal(view.protocol, DECISION_VIEW_PROTOCOL);
  });

  it('publishes request, result, and view definitions in one schema', () => {
    const schemaPath = path.join(packageRoot, 'schemas', 'decision.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
      $id?: string;
      $defs?: Record<string, unknown>;
    };
    assert.equal(schema.$id, 'https://codex-im-suite.local/schemas/decision.schema.json');
    assert.ok(schema.$defs?.DecisionRequestContract);
    assert.ok(schema.$defs?.DecisionResultContract);
    assert.ok(schema.$defs?.DecisionViewContract);
  });
});
