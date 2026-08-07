import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFeishuBotMissingAppScopes,
  extractFeishuCliUserAuthorizationChallenge,
  extractFeishuCliUserAuthorizationPolicyViolation,
} from '../../lib/bridge/feishu-cli-user-auth';

const validToolInput = {
  command: [
    '$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER="1";',
    'lark-cli auth login --scope "task:task:read" --no-wait --json',
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
      requestedScopes: ['task:task:read'],
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

  it('rejects recommend, domain bundles, and multiple scopes before any authorization card is accepted', () => {
    const broadCommands = [
      'lark-cli auth login --recommend --no-wait --json',
      'lark-cli auth login --domain contact --no-wait --json',
      'lark-cli auth login --scope "task:task:read calendar:calendar:readonly" --no-wait --json',
    ];
    const expectedCodes = ['broad_recommend', 'domain_bundle', 'multiple_scopes'];
    broadCommands.forEach((command, index) => {
      const input = {
        toolUseId: `tool-broad-${index}`,
        toolName: 'Bash',
        toolInput: { command },
        toolResultContent: validToolResult,
        toolResultIsError: false,
      };
      assert.equal(extractFeishuCliUserAuthorizationPolicyViolation(input)?.code, expectedCodes[index]);
      assert.equal(extractFeishuCliUserAuthorizationChallenge(input), null);
    });
  });

  it('accepts the non-blocking JSON flags when PowerShell wrapper quotes close immediately after them', () => {
    const wrappedInput = {
      command: [
        '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command',
        "'$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER=\"1\";",
        "lark-cli auth login --scope 'task:task:write' --no-wait --json'",
      ].join(' '),
    };

    const challenge = extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-auth-powershell-wrapper',
      toolName: 'Bash',
      toolInput: wrappedInput,
      toolResultContent: validToolResult,
      toolResultIsError: false,
    });

    assert.equal(challenge?.requestedScopes[0], 'task:task:write');
    assert.equal(challenge?.verificationUrl, 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow-1&user_code=ABCD-EFGH');
  });

  it('does not confuse longer option names with the required boolean flags', () => {
    assert.equal(extractFeishuCliUserAuthorizationChallenge({
      toolUseId: 'tool-auth-lookalike-flags',
      toolName: 'Bash',
      toolInput: {
        command: 'lark-cli auth login --scope "task:task:read" --no-waiting --json-output',
      },
      toolResultContent: validToolResult,
      toolResultIsError: false,
    }), null);
  });

  it('keeps bot app-scope approval separate from user OAuth', () => {
    const botError = JSON.stringify({
      ok: false,
      identity: 'bot',
      error: {
        subtype: 'app_scope_not_applied',
        code: 99991672,
        identity: 'bot',
        missing_scopes: ['contact:contact.base:readonly', 'contact:contact:readonly'],
      },
    });
    const botScopes = extractFeishuBotMissingAppScopes(botError);
    assert.deepEqual(botScopes, ['contact:contact.base:readonly', 'contact:contact:readonly']);
    const input = {
      toolUseId: 'tool-bot-scope',
      toolName: 'Bash',
      toolInput: { command: 'lark-cli auth login --scope "contact:contact.base:readonly" --no-wait --json' },
      toolResultContent: validToolResult,
      toolResultIsError: false,
    };
    assert.equal(
      extractFeishuCliUserAuthorizationPolicyViolation(input, botScopes)?.code,
      'bot_scope_requires_admin',
    );
    assert.equal(extractFeishuCliUserAuthorizationChallenge(input, botScopes), null);
  });
});
