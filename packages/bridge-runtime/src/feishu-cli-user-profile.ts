import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CTI_HOME } from './config.js';

/**
 * lark-cli 的用户 token 默认落在本机共享配置目录。Bridge 不能让不同飞书
 * 发起人的请求共用这个目录，否则后一次登录会覆盖前一次用户身份。这里为
 * 每个真实入站 userId 建立独立配置目录；目录名只使用不可逆摘要，避免把
 * 平台身份直接暴露在运行态路径中。
 */
export function resolveFeishuCliUserConfigDir(userId: string): string | undefined {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return undefined;

  const sourceDir = process.env.LARKSUITE_CLI_CONFIG_DIR?.trim()
    || path.join(os.homedir(), '.lark-cli');
  const sourceConfigPath = path.join(sourceDir, 'config.json');
  if (!fs.existsSync(sourceConfigPath)) return undefined;

  const targetRoot = path.join(CTI_HOME, 'runtime', 'lark-cli-users');
  const userKey = crypto.createHash('sha256').update(normalizedUserId, 'utf8').digest('hex').slice(0, 32);
  const targetDir = path.join(targetRoot, userKey);
  const targetConfigPath = path.join(targetDir, 'config.json');
  // 先检查并创建受管根；只检查最终 user 目录不足以防止父级 junction
  // 把整个隔离树导向工作区或其它运行态目录。
  try {
    for (const directory of [path.join(CTI_HOME, 'runtime'), targetRoot]) {
      if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) return undefined;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    for (const directory of [path.join(CTI_HOME, 'runtime'), targetRoot, targetDir]) {
      if (fs.lstatSync(directory).isSymbolicLink()) return undefined;
    }
  } catch {
    return undefined;
  }

  // 运行态目录只能是普通目录/文件，避免配置被 junction 或符号链接导向
  // 工作区、用户目录或另一位发起人的凭据目录。
  try {
    if (fs.lstatSync(targetDir).isSymbolicLink()) return undefined;
    if (fs.existsSync(targetConfigPath) && fs.lstatSync(targetConfigPath).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }

  if (!fs.existsSync(targetConfigPath)) {
    let sourceConfig: unknown;
    try {
      sourceConfig = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8'));
    } catch {
      return undefined;
    }
    if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) return undefined;
    const apps = (sourceConfig as { apps?: unknown }).apps;
    if (!Array.isArray(apps) || apps.length === 0) return undefined;

    // 只复制 app 配置和 keychain 引用，不复制共享 users/token 状态。
    const isolatedConfig = {
      ...(sourceConfig as Record<string, unknown>),
      apps: apps
        .filter((app): app is Record<string, unknown> => Boolean(app && typeof app === 'object' && !Array.isArray(app)))
        .map((app) => ({
          ...app,
          // 仅保留当前 sender 自己已经授权过的元数据；其他用户的 token
          // 即使存在于系统 keychain，也不会因配置复制而对本轮可见。
          users: Array.isArray(app.users)
            ? app.users.filter((user) => (
              Boolean(user && typeof user === 'object' && !Array.isArray(user))
              && String((user as Record<string, unknown>).userOpenId || '').trim() === normalizedUserId
            ))
            : [],
        })),
    };
    if (isolatedConfig.apps.length === 0) return undefined;
    const tempPath = `${targetConfigPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(isolatedConfig, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      try {
        fs.renameSync(tempPath, targetConfigPath);
      } catch {
        // 另一个并发回合已经完成初始化时，保留对方的完整配置。
        if (fs.existsSync(targetConfigPath)) fs.unlinkSync(tempPath);
        else throw new Error('failed to initialize isolated lark-cli config');
      }
    } catch {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* best effort */ }
      return undefined;
    }
  }

  try {
    const persisted = JSON.parse(fs.readFileSync(targetConfigPath, 'utf8')) as { apps?: unknown };
    if (!Array.isArray(persisted.apps) || persisted.apps.length === 0) return undefined;
    // 目录可能来自旧版本、并发初始化或人工篡改；每次使用前都复核
    // users 元数据，发现另一位 sender 的身份即失败关闭，绝不沿用旧 token。
    for (const rawApp of persisted.apps) {
      if (!rawApp || typeof rawApp !== 'object' || Array.isArray(rawApp)) return undefined;
      const users = (rawApp as { users?: unknown }).users;
      if (users === undefined) continue;
      if (!Array.isArray(users)) return undefined;
      for (const rawUser of users) {
        if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) return undefined;
        const persistedUserId = String((rawUser as { userOpenId?: unknown }).userOpenId || '').trim();
        if (!persistedUserId || persistedUserId !== normalizedUserId) return undefined;
      }
    }
  } catch {
    // 配置损坏时拒绝执行，不把共享目录作为隐式回退。
    return undefined;
  }

  return targetDir;
}
