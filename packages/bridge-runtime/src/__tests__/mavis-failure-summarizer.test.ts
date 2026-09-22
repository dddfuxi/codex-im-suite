import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeToolResult, summarizeMavisFailureMessage } from '../mavis-failure-summarizer.js';

describe('mavis failure summarizer', () => {
  describe('summarizeMavisFailureMessage', () => {
    it('returns a stable short summary for quota / rate limit', () => {
      assert.equal(
        summarizeMavisFailureMessage('Error: 429 quota exceeded'),
        '远端 API 额度或速率限制',
      );
    });

    it('returns a stable short summary for 401 / auth', () => {
      assert.equal(
        summarizeMavisFailureMessage('401 unauthorized, refresh token failed'),
        '远端登录已失效',
      );
    });

    it('returns a stable short summary for timeout', () => {
      assert.equal(
        summarizeMavisFailureMessage('request ETIMEDOUT after 30s'),
        '远端调用超时',
      );
    });

    it('returns a stable short summary for connection refused', () => {
      assert.equal(
        summarizeMavisFailureMessage('Error: ECONNREFUSED 127.0.0.1:17321'),
        '远端服务不可达',
      );
    });

    it('returns a stable short summary for 404 / GC', () => {
      assert.equal(
        summarizeMavisFailureMessage('mavis session mvs_abc 404 not found'),
        '远端资源不存在（session 可能已被 GC）',
      );
    });

    it('truncates long unknown messages at maxLen', () => {
      const long = 'a'.repeat(500);
      const result = summarizeMavisFailureMessage(long, 50);
      assert.ok(result.length <= 50);
      assert.ok(result.endsWith('...'));
    });

    it('returns the original (short) message when no pattern matches', () => {
      assert.equal(
        summarizeMavisFailureMessage('some unique thing happened'),
        'some unique thing happened',
      );
    });

    it('collapses whitespace before truncation', () => {
      const result = summarizeMavisFailureMessage('a\n\nb   c', 100);
      assert.equal(result, 'a b c');
    });

    it('returns fallback for empty / non-string input', () => {
      assert.equal(summarizeMavisFailureMessage(undefined), '远端返回未提供错误细节');
      assert.equal(summarizeMavisFailureMessage(''), '远端返回未提供错误细节');
    });
  });

  describe('sanitizeToolResult', () => {
    it('drops <skill_content> blocks', () => {
      const result = sanitizeToolResult('before <skill_content>SECRET</skill_content> after');
      assert.ok(!result.includes('SECRET'));
      assert.ok(result.includes('[已脱敏]'));
      assert.ok(result.includes('before'));
      assert.ok(result.includes('after'));
    });

    it('drops HTML comments', () => {
      const result = sanitizeToolResult('a <!-- comment with token --> b');
      assert.ok(!result.includes('token'));
      assert.ok(result.includes('[已脱敏]'));
    });

    it('drops <citation> blocks', () => {
      const result = sanitizeToolResult('pre <citation>ref:abc</citation> post');
      assert.ok(!result.includes('ref:abc'));
      assert.ok(result.includes('[已脱敏]'));
    });

    it('truncates long results with ellipsis', () => {
      const long = 'a'.repeat(1000);
      const result = sanitizeToolResult(long, 100);
      assert.ok(result.length <= 100);
      assert.ok(result.endsWith('...'));
    });

    it('returns empty string for non-string input', () => {
      assert.equal(sanitizeToolResult(undefined as unknown as string), '');
      assert.equal(sanitizeToolResult(null as unknown as string), '');
    });

    it('collapses whitespace after dropping patterns', () => {
      const result = sanitizeToolResult('a   b   c');
      assert.equal(result, 'a b c');
    });
  });
});
