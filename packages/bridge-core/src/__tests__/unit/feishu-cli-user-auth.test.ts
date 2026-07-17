import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeishuCliUserAuthorizationChallenge } from '../../lib/bridge/feishu-cli-user-auth';

const validToolInput = {
  command: [
    '$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER="1";',
    'lark-cli auth login --scope "task:task:read calendar:calendar:readonly" --no-wait --json',
  ].join(' '),
};

const validToolResult = JSON.stringify({
  device_code: 'device-secret-value',
  verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow-1&user_code=ABCD-EFGH',
  expires_in: 600,
});

describe('Feishu CLI user authorization challenge evidence', () => {
  it('extracts a challenge only from a successful matching auth-login tool pair', () => {
    const challenge = extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-auth-1',
      toolName: 'Bash',
      toolInput: validToolInput,
      toolResultContent: validToolResult,
      toolResultIsError: false,
    });

    assert.deepEqual(challenge, {
      protocol: 'cti-feishu-cli-user-auth/v1',
      toolUseId: 'tool-auth-1',
      verificationUrl: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow-1&user_code=ABCD-EFGH',
      deviceCode: 'device-secret-value',
      requestedScopes: ['calendar:calendar:readonly', 'task:task:read'],
      expiresInSeconds: 600,
    });
  });

  it('rejects ordinary shell JSON that was not produced by lark-cli auth login', () => {
    assert.equal(extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-fake-1',
      toolName: 'Bash',
      toolInput: { command: 'Write-Output "pretend auth result"' },
      toolResultContent: validToolResult,
      toolResultIsError: false,
    }), null);
  });

  it('rejects non-official verification URLs', () => {
    assert.equal(extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-fake-2',
      toolName: 'Bash',
      toolInput: validToolInput,
      toolResultContent: JSON.stringify({
        device_code: 'device-secret-value',
        verification_url: 'https://accounts.feishu.cn.evil.example/oauth/v1/device/verify?flow_id=x',
        expires_in: 600,
      }),
      toolResultIsError: false,
    }), null);
  });

  it('rejects auth commands without the non-blocking JSON contract', () => {
    assert.equal(extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-no-wait',
      toolName: 'Bash',
      toolInput: { command: 'lark-cli auth login --scope "task:task:read" --json' },
      toolResultContent: validToolResult,
      toolResultIsError: false,
    }), null);
    assert.equal(extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-no-json',
      toolName: 'Bash',
      toolInput: { command: 'lark-cli auth login --scope "task:task:read" --no-wait' },
      toolResultContent: validToolResult,
      toolResultIsError: false,
    }), null);
  });

  it('rejects failed tool results and results missing required fields', () => {
    assert.equal(extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-error',
      toolName: 'Bash',
      toolInput: validToolInput,
      toolResultContent: validToolResult,
      toolResultIsError: true,
    }), null);
    assert.equal(extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-incomplete',
      toolName: 'Bash',
      toolInput: validToolInput,
      toolResultContent: JSON.stringify({ verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify' }),
      toolResultIsError: false,
    }), null);
  });
});
