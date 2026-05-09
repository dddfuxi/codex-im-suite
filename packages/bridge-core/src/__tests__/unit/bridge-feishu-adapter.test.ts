import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';

describe('FeishuAdapter mention detection fallback', () => {
  it('detects bot mention from text content when mentions array is missing', () => {
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');

    const mentioned = adapter.isBotMentionedFromMessage({
      content: JSON.stringify({
        text: '<at user_id="ou_bot">Codex</at> 帮我看一下',
      }),
      mentions: undefined,
    });

    assert.equal(mentioned, true);
  });

  it('detects bot mention from post content when mentions array is missing', () => {
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');

    const mentioned = adapter.isBotMentionedFromMessage({
      content: JSON.stringify({
        title: '',
        content: [[
          { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
          { tag: 'text', text: ' 帮我看一下' },
        ]],
      }),
      mentions: undefined,
    });

    assert.equal(mentioned, true);
  });
});

describe('FeishuAdapter reply fallback', () => {
  it('retries as plain chat send when reply target was withdrawn', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async () => {
            calls.push('reply');
            const error: any = new Error('Request failed with status code 400');
            error.response = {
              data: {
                code: 230011,
                msg: 'The message was withdrawn.',
              },
            };
            throw error;
          },
          create: async () => {
            calls.push('create');
            return { data: { message_id: 'om_new' } };
          },
        },
      },
    };

    const result = await adapter.sendAsPlainText('oc_group', '测试回复', 'om_old');

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_new');
    assert.deepStrictEqual(calls, ['reply', 'create']);
  });

  it('retries card send as plain chat send when reply target was withdrawn', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async () => {
            calls.push('reply');
            const error: any = new Error('Request failed with status code 400');
            error.response = {
              data: {
                code: 230011,
                msg: 'The message was withdrawn.',
              },
            };
            throw error;
          },
          create: async () => {
            calls.push('create');
            return { data: { message_id: 'om_new' } };
          },
        },
      },
    };

    const result = await adapter.sendAsCard('oc_group', '测试回复', 'om_old');

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_new');
    assert.deepStrictEqual(calls, ['reply', 'create']);
  });
});
