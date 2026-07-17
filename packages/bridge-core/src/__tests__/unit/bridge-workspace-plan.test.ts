import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadWorkspacePlanModule() {
  try {
    return await import('../../lib/bridge/workspace-plan.js');
  } catch {
    return null;
  }
}

describe('TurnWorkspacePlan', () => {
  it('mounts only the current workspace when no explicit project is referenced', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '检查当前项目的状态',
      currentWorkingDirectory: 'F:\\unity\\ST4',
      defaultWorkingDirectory: 'F:\\unity\\ST4',
      registeredRoots: ['F:\\unity\\ST4', 'C:\\unity\\ST3', 'F:\\unity\\ST3_master'],
      deniedRoots: [
        { path: 'E:\\cli-md', reason: 'memory repository' },
        { path: 'C:\\Users\\admin\\.claude-to-im', reason: 'runtime data' },
      ],
      requiresWrite: false,
      now: '2026-07-17T12:00:00.000Z',
    });

    assert.equal(plan.version, 'cti-turn-workspace/v1');
    assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
    assert.equal(plan.primaryWorkspace.accessMode, 'read_only');
    assert.deepEqual(plan.temporaryMounts, []);
    assert.equal(plan.resolvedFrom, 'session_binding');
    assert.equal(plan.expiresAfterTurn, true);
  });

  it('does not turn registered allowed roots into automatic mounts', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '列出当前目录',
      currentWorkingDirectory: 'F:\\unity\\ST4',
      defaultWorkingDirectory: 'F:\\unity\\ST4',
      registeredRoots: ['F:\\unity\\ST4', 'C:\\unity\\ST3', 'F:\\unity\\ST3_master'],
      deniedRoots: [],
      requiresWrite: false,
    });

    assert.deepEqual(module.getWorkspacePlanRoots(plan), ['F:\\unity\\ST4']);
  });

  it('keeps the current workspace primary and mounts an explicitly referenced project temporarily', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '检查 C:\\unity\\ST3\\Assets\\Prefabs\\Desk.prefab 的引用',
      currentWorkingDirectory: 'F:\\unity\\ST4',
      defaultWorkingDirectory: 'F:\\unity\\ST4',
      registeredRoots: ['C:\\unity', 'C:\\unity\\ST3', 'F:\\unity\\ST4'],
      deniedRoots: [],
      requiresWrite: false,
    });

    assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
    assert.equal(plan.resolvedFrom, 'session_binding');
    assert.deepEqual(plan.temporaryMounts.map((item: { path: string }) => item.path), ['C:\\unity\\ST3']);
    assert.match(plan.temporaryMounts[0].reason, /explicit/i);
  });

  it('keeps additional explicitly referenced projects as turn-scoped mounts', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '对照 "C:\\unity\\ST3\\Assets" 和 "F:\\unity\\ST3_master\\Assets" 的材质差异',
      currentWorkingDirectory: 'F:\\unity\\ST4',
      defaultWorkingDirectory: 'F:\\unity\\ST4',
      registeredRoots: ['C:\\unity\\ST3', 'F:\\unity\\ST3_master', 'F:\\unity\\ST4'],
      deniedRoots: [],
      requiresWrite: false,
    });

    assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
    assert.deepEqual(plan.temporaryMounts.map((item: { path: string }) => item.path), [
      'C:\\unity\\ST3',
      'F:\\unity\\ST3_master',
    ]);
    assert.equal(plan.temporaryMounts[0].expiresAfterTurn, true);
  });

  it('does not duplicate the current project as a temporary mount', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '检查 F:\\unity\\ST4\\Assets\\Config.asset',
      currentWorkingDirectory: 'F:\\unity\\ST4',
      defaultWorkingDirectory: 'F:\\unity\\ST4',
      registeredRoots: ['F:\\unity\\ST4', 'C:\\unity\\ST3'],
      deniedRoots: [],
      requiresWrite: false,
    });

    assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
    assert.deepEqual(plan.temporaryMounts, []);
  });

  it('rejects denied or out-of-bound session workspaces before choosing a safe fallback', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '检查当前项目',
      currentWorkingDirectory: 'E:\\cli-md',
      defaultWorkingDirectory: 'C:\\outside\\unknown',
      registeredRoots: ['F:\\unity\\ST4'],
      deniedRoots: [{ path: 'E:\\cli-md', reason: 'memory repository' }],
      requiresWrite: false,
    });

    assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
    assert.equal(plan.resolvedFrom, 'default');
  });

  it('fails closed when every possible primary workspace is denied', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    assert.throws(() => module.resolveTurnWorkspacePlan({
      prompt: '检查当前项目',
      currentWorkingDirectory: 'E:\\cli-md',
      defaultWorkingDirectory: 'E:\\cli-md',
      registeredRoots: ['E:\\cli-md'],
      deniedRoots: [
        { path: 'E:\\cli-md', reason: 'memory repository' },
        { path: process.cwd(), reason: 'test denied cwd' },
      ],
      requiresWrite: false,
    }), /no safe primary workspace/i);
  });

  it('never promotes denied memory or runtime paths into workspace mounts', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '读取 E:\\cli-md\\memory\\users 和 C:\\Users\\admin\\.claude-to-im\\runtime',
      currentWorkingDirectory: 'F:\\unity\\ST4',
      defaultWorkingDirectory: 'F:\\unity\\ST4',
      registeredRoots: ['F:\\unity\\ST4', 'E:\\cli-md', 'C:\\Users\\admin\\.claude-to-im'],
      deniedRoots: [
        { path: 'E:\\cli-md', reason: 'memory repository' },
        { path: 'C:\\Users\\admin\\.claude-to-im', reason: 'runtime data' },
      ],
      requiresWrite: false,
    });

    assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
    assert.deepEqual(plan.temporaryMounts, []);
    assert.deepEqual(plan.deniedRoots.map((item: { reason: string }) => item.reason), ['memory repository', 'runtime data']);
  });

  it('marks explicit modification turns as read-write without changing expiry', async () => {
    const module = await loadWorkspacePlanModule();
    assert.ok(module, 'workspace plan module should exist');

    const plan = module.resolveTurnWorkspacePlan({
      prompt: '修改 F:\\unity\\ST4\\Assets\\Config.asset',
      currentWorkingDirectory: 'F:\\unity\\ST4',
      defaultWorkingDirectory: 'F:\\unity\\ST4',
      registeredRoots: ['F:\\unity\\ST4'],
      deniedRoots: [],
      requiresWrite: true,
    });

    assert.equal(plan.primaryWorkspace.accessMode, 'read_write');
    assert.equal(plan.expiresAfterTurn, true);
  });
});
