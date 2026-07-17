import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFeishuCliUserAuthHost,
  type FeishuCliDeviceAuthorizationRunner,
} from '../feishu-cli-user-auth.js';

const challenge = {
  protocol: 'cti-feishu-cli-user-auth/v1' as const,
  toolUseId: 'tool-auth-1',
  verificationUrl: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow-1&user_code=ABCD-EFGH',
  deviceCode: 'device-secret-value',
  requestedScopes: ['task:task:read'],
  expiresInSeconds: 600,
};

function request(messageId: string) {
  return {
    challenge,
    text: '查询一下今日待办',
    channelType: 'feishu',
    chatId: 'oc_auth',
    userId: 'ou_owner',
    userDisplayName: 'Owner',
    messageId,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for async authorization result');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Feishu CLI user auth runtime broker', () => {
  it('builds a Card 2.0 open-url authorization card without exposing the device code', async () => {
    let finishAuthorization!: (value: { ok: true }) => void;
    const runner: FeishuCliDeviceAuthorizationRunner = {
      waitForAuthorization: () => new Promise((resolve) => { finishAuthorization = resolve; }),
    };
    const host = createFeishuCliUserAuthHost({
      runner,
      onResume: async () => {},
      onNotify: async () => {},
    });

    const result = await host.beginAuthorization(request('m_1'));
    const card = JSON.parse(result.feishuCardJson || '{}');

    assert.equal(result.status, 'started');
    assert.equal(card.schema, '2.0');
    assert.equal(card.config.width_mode, 'default');
    assert.equal(card.header.template, 'blue');
    assert.match(JSON.stringify(card), /task:task:read/);
    assert.match(JSON.stringify(card), /open_url/);
    assert.match(JSON.stringify(card), /accounts\.feishu\.cn/);
    assert.doesNotMatch(JSON.stringify(card), /device-secret-value/);
    finishAuthorization({ ok: true });
  });

  it('deduplicates same Owner and scopes, then resumes every merged task after authorization', async () => {
    let runnerCalls = 0;
    let finishAuthorization!: (value: { ok: true }) => void;
    const runner: FeishuCliDeviceAuthorizationRunner = {
      waitForAuthorization: () => {
        runnerCalls += 1;
        return new Promise((resolve) => { finishAuthorization = resolve; });
      },
    };
    const resumed: string[] = [];
    const host = createFeishuCliUserAuthHost({
      runner,
      onResume: async (resume) => { resumed.push(resume.messageId || ''); },
      onNotify: async () => {},
    });

    const first = await host.beginAuthorization(request('m_1'));
    const second = await host.beginAuthorization(request('m_2'));

    assert.equal(first.status, 'started');
    assert.equal(second.status, 'reused');
    assert.equal(second.feishuCardJson, undefined);
    assert.equal(runnerCalls, 1);

    finishAuthorization({ ok: true });
    await waitUntil(() => resumed.length === 2);
    assert.deepEqual(resumed, ['m_1', 'm_2']);
  });

  it('sends a red unfinished result on expiry without leaking authorization secrets', async () => {
    const notifications: Array<{ text: string; feishuCardJson?: string }> = [];
    const host = createFeishuCliUserAuthHost({
      runner: {
        waitForAuthorization: async () => ({ ok: false, reason: 'expired' }),
      },
      onResume: async () => {
        throw new Error('expired authorization must not resume tasks');
      },
      onNotify: async (notification) => {
        notifications.push({ text: notification.text, feishuCardJson: notification.feishuCardJson });
      },
    });

    await host.beginAuthorization(request('m_1'));
    await waitUntil(() => notifications.length === 1);

    assert.match(notifications[0].text, /未完成/);
    assert.match(notifications[0].text, /过期/);
    const card = JSON.parse(notifications[0].feishuCardJson || '{}');
    assert.equal(card.header.template, 'red');
    assert.doesNotMatch(JSON.stringify(notifications[0]), /device-secret-value|flow-1|ABCD-EFGH/);
  });
});
