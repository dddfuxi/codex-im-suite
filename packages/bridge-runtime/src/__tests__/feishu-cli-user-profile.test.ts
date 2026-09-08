import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeSourceConfig(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify({
    apps: [{
      appId: 'cli_test_app',
      appSecret: { source: 'keychain', id: 'appsecret:cli_test_app' },
      brand: 'feishu',
      users: [
        { userOpenId: 'ou_owner', userName: 'Owner' },
        { userOpenId: 'ou_member', userName: 'Member' },
      ],
    }],
  }, null, 2)}\n`, 'utf8');
}

describe('Feishu CLI user profile isolation', { concurrency: false }, () => {
  it('maps different real sender IDs to different profiles and filters copied users', async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-lark-source-'));
    const previousConfigDir = process.env.LARKSUITE_CLI_CONFIG_DIR;
    writeSourceConfig(sourceRoot);
    process.env.LARKSUITE_CLI_CONFIG_DIR = sourceRoot;
    try {
      const { resolveFeishuCliUserConfigDir } = await import('../feishu-cli-user-profile.js');
      const ownerDir = resolveFeishuCliUserConfigDir('ou_owner');
      const memberDir = resolveFeishuCliUserConfigDir('ou_member');
      assert.ok(ownerDir);
      assert.ok(memberDir);
      assert.notEqual(ownerDir, memberDir);
      assert.match(path.basename(ownerDir), /^[a-f0-9]{32}$/u);
      assert.match(path.basename(memberDir), /^[a-f0-9]{32}$/u);
      assert.equal(path.basename(ownerDir), crypto.createHash('sha256').update('ou_owner').digest('hex').slice(0, 32));
      assert.equal(path.basename(memberDir), crypto.createHash('sha256').update('ou_member').digest('hex').slice(0, 32));

      const ownerConfig = JSON.parse(fs.readFileSync(path.join(ownerDir, 'config.json'), 'utf8')) as any;
      const memberConfig = JSON.parse(fs.readFileSync(path.join(memberDir, 'config.json'), 'utf8')) as any;
      assert.deepEqual(ownerConfig.apps[0].users.map((user: any) => user.userOpenId), ['ou_owner']);
      assert.deepEqual(memberConfig.apps[0].users.map((user: any) => user.userOpenId), ['ou_member']);
      assert.doesNotMatch(JSON.stringify(memberConfig), /ou_owner/u);

      // 即使目录已经存在，也不能接受被旧逻辑或外部写入的跨用户 metadata。
      fs.writeFileSync(path.join(memberDir, 'config.json'), JSON.stringify({
        apps: [{ appId: 'cli_test_app', users: [{ userOpenId: 'ou_owner' }] }],
      }), 'utf8');
      assert.equal(resolveFeishuCliUserConfigDir('ou_member'), undefined);
    } finally {
      if (previousConfigDir === undefined) delete process.env.LARKSUITE_CLI_CONFIG_DIR;
      else process.env.LARKSUITE_CLI_CONFIG_DIR = previousConfigDir;
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked managed profile root instead of escaping runtime state', async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-lark-source-'));
    const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-lark-escape-'));
    const previousConfigDir = process.env.LARKSUITE_CLI_CONFIG_DIR;
    writeSourceConfig(sourceRoot);
    process.env.LARKSUITE_CLI_CONFIG_DIR = sourceRoot;
    try {
      const { CTI_HOME } = await import('../config.js');
      const managedRuntime = path.join(CTI_HOME, 'runtime');
      const managedRoot = path.join(managedRuntime, 'lark-cli-users');
      fs.mkdirSync(managedRuntime, { recursive: true });
      fs.rmSync(managedRoot, { recursive: true, force: true });
      fs.symlinkSync(escapeRoot, managedRoot, 'junction');
      const { resolveFeishuCliUserConfigDir } = await import('../feishu-cli-user-profile.js');
      assert.equal(resolveFeishuCliUserConfigDir('ou_symlink_guard'), undefined);
      assert.equal(fs.readdirSync(escapeRoot).length, 0);
    } finally {
      if (previousConfigDir === undefined) delete process.env.LARKSUITE_CLI_CONFIG_DIR;
      else process.env.LARKSUITE_CLI_CONFIG_DIR = previousConfigDir;
      const { CTI_HOME } = await import('../config.js');
      fs.rmSync(path.join(CTI_HOME, 'runtime', 'lark-cli-users'), { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(escapeRoot, { recursive: true, force: true });
    }
  });

  it('injects the sender-specific profile into Codex tool environment', async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-lark-source-'));
    const previousConfigDir = process.env.LARKSUITE_CLI_CONFIG_DIR;
    const previousCodexHome = process.env.CODEX_HOME;
    writeSourceConfig(sourceRoot);
    process.env.LARKSUITE_CLI_CONFIG_DIR = sourceRoot;
    try {
      const { buildCodexClientOptionsForTest } = await import('../codex-provider.js');
      const ownerOptions = buildCodexClientOptionsForTest('primary', [], 'ou_owner');
      const memberOptions = buildCodexClientOptionsForTest('primary', [], 'ou_member');
      assert.ok(ownerOptions.env.LARKSUITE_CLI_CONFIG_DIR);
      assert.ok(memberOptions.env.LARKSUITE_CLI_CONFIG_DIR);
      assert.notEqual(ownerOptions.env.LARKSUITE_CLI_CONFIG_DIR, memberOptions.env.LARKSUITE_CLI_CONFIG_DIR);
      assert.match(ownerOptions.env.LARKSUITE_CLI_CONFIG_DIR, /lark-cli-users[\\/][a-f0-9]{32}$/u);
      assert.match(memberOptions.env.LARKSUITE_CLI_CONFIG_DIR, /lark-cli-users[\\/][a-f0-9]{32}$/u);
    } finally {
      if (previousConfigDir === undefined) delete process.env.LARKSUITE_CLI_CONFIG_DIR;
      else process.env.LARKSUITE_CLI_CONFIG_DIR = previousConfigDir;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      const { CTI_HOME } = await import('../config.js');
      fs.rmSync(path.join(CTI_HOME, 'runtime', 'lark-cli-users'), { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('fails closed instead of inheriting a shared profile when isolation is unavailable', async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-lark-source-'));
    const previousConfigDir = process.env.LARKSUITE_CLI_CONFIG_DIR;
    const previousCodexHome = process.env.CODEX_HOME;
    writeSourceConfig(sourceRoot);
    // 模拟当前进程残留了 Owner 的共享目录，但本轮 sender 没有可用隔离配置。
    process.env.LARKSUITE_CLI_CONFIG_DIR = path.join(sourceRoot, 'missing-profile.json');
    try {
      const { buildCodexClientOptionsForTest } = await import('../codex-provider.js');
      assert.throws(
        () => buildCodexClientOptionsForTest('primary', [], 'ou_member_without_profile'),
        /no isolated Feishu CLI profile/u,
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.LARKSUITE_CLI_CONFIG_DIR;
      else process.env.LARKSUITE_CLI_CONFIG_DIR = previousConfigDir;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      const { CTI_HOME } = await import('../config.js');
      fs.rmSync(path.join(CTI_HOME, 'runtime', 'lark-cli-users'), { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});
