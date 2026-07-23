import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildWorkspaceChatCatalog,
  parseWorkspaceChatCommand,
  resolveWorkspaceChatTarget,
} from '../../lib/bridge/workspace-chat-policy.js';

const projects = [
  {
    id: 'st4',
    displayName: 'ST4',
    type: 'unity' as const,
    workspaceRoot: 'F:\\unity\\ST4',
    unityProjectRoot: 'F:\\unity\\ST4',
    accessMode: 'read_write' as const,
    enabled: true,
  },
  {
    id: 'st3-master',
    displayName: 'ST3_master',
    type: 'unity' as const,
    workspaceRoot: 'F:\\unity\\ST3_master',
    unityProjectRoot: 'F:\\unity\\ST3_master',
    accessMode: 'read_only' as const,
    enabled: true,
  },
  {
    id: 'disabled',
    displayName: 'Disabled',
    type: 'generic' as const,
    workspaceRoot: 'C:\\disabled',
    accessMode: 'read_write' as const,
    enabled: false,
  },
];

describe('workspace chat policy', () => {
  it('只识别明确的工作区列出和切换表达', () => {
    assert.deepEqual(parseWorkspaceChatCommand('列出当前可用工作区'), { kind: 'list' });
    assert.deepEqual(parseWorkspaceChatCommand('当前有哪些工作区？'), { kind: 'list' });
    assert.deepEqual(parseWorkspaceChatCommand('工作区'), { kind: 'list' });
    assert.deepEqual(parseWorkspaceChatCommand('我想切换工作区'), { kind: 'list' });
    assert.deepEqual(parseWorkspaceChatCommand('切换工作目录'), { kind: 'list' });
    assert.deepEqual(parseWorkspaceChatCommand('我需要选择工作路径'), { kind: 'list' });
    assert.deepEqual(parseWorkspaceChatCommand('把当前工作区切换到 ST4'), { kind: 'switch', target: 'ST4' });
    assert.deepEqual(parseWorkspaceChatCommand('切换到工作区 2'), { kind: 'switch', target: '2' });
    assert.deepEqual(parseWorkspaceChatCommand('切换工作目录到 ST4'), { kind: 'switch', target: 'ST4' });
    assert.equal(parseWorkspaceChatCommand('在 ST4 项目里检查资源'), null);
    assert.equal(parseWorkspaceChatCommand('介绍一下工作区切换原理'), null);
    assert.equal(parseWorkspaceChatCommand('工作目录'), null);
    assert.equal(parseWorkspaceChatCommand('导致构建失败，当前工作路径配置错误'), null);
  });

  it('只列出启用项目并标记当前工作区', () => {
    const catalog = buildWorkspaceChatCatalog(projects, 'F:\\unity\\ST4\\');
    assert.deepEqual(catalog.map((item) => item.project.id), ['st3-master', 'st4']);
    assert.equal(catalog[0].current, false);
    assert.equal(catalog[1].current, true);
  });

  it('按编号、稳定 ID、名称和唯一模糊名称解析', () => {
    const catalog = buildWorkspaceChatCatalog(projects);
    assert.equal(resolveWorkspaceChatTarget(catalog, '1').kind, 'resolved');
    assert.equal(resolveWorkspaceChatTarget(catalog, 'st3-master').kind, 'resolved');
    assert.equal(resolveWorkspaceChatTarget(catalog, 'ST4').kind, 'resolved');
    assert.equal(resolveWorkspaceChatTarget(catalog, 'master').kind, 'resolved');
    assert.equal(resolveWorkspaceChatTarget(catalog, 'unknown').kind, 'not_found');
  });
});
