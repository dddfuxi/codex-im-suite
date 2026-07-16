import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ARCHITECTURE_LAYER_IDS,
  classifySuitePath,
  compileAgentArchitectureRegistry,
  decideSkillLifecycleAction,
  getAgentPolicyPromptLines,
  getPermissionApprovalRequiredRole,
  getSlashCommandRequiredRole,
  isDangerousUserRequest,
  isHighRiskPermissionInput,
  isHighRiskPermissionToolName,
  isNonAddressableMentionTarget,
  isSystemAffectingReminderRequest,
  shouldSearchSkillCatalog,
} from '../../lib/bridge/agent-architecture.js';

describe('agent architecture registry', () => {
  const roots = {
    suiteRoot: 'C:\\suite',
    liveSkillRoots: ['C:\\Users\\admin\\.codex\\skills\\claude-to-im'],
    memoryRepoRoots: ['E:\\cli-md'],
    runtimeDataRoots: ['C:\\Users\\admin\\.claude-to-im\\data', 'C:\\Users\\admin\\.claude-to-im\\runtime'],
    logRoots: ['C:\\Users\\admin\\.claude-to-im\\logs'],
    releaseRoots: ['C:\\suite\\release'],
  };

  it('compiles the required robot architecture layers with unique policy ownership', () => {
    const compiled = compileAgentArchitectureRegistry();

    assert.deepEqual(AGENT_ARCHITECTURE_LAYER_IDS, [
      'agent_kernel',
      'policy_registry',
      'context_broker',
      'capability_router',
      'memory_system',
      'scratchpad',
      'prompt_composer',
      'delivery_layer',
    ]);
    assert.deepEqual(compiled.layers.map((layer) => layer.id), AGENT_ARCHITECTURE_LAYER_IDS);
    assert.equal(new Set(compiled.policies.map((policy) => policy.id)).size, compiled.policies.length);

    const layerIds = new Set(compiled.layers.map((layer) => layer.id));
    for (const policy of compiled.policies) {
      assert.equal(layerIds.has(policy.layerId), true, `${policy.id} should belong to a known layer`);
    }
  });

  it('classifies project paths by responsibility instead of one-off locations', () => {
    assert.equal(classifySuitePath('C:\\suite\\packages\\bridge-core\\src\\lib\\bridge\\bridge-manager.ts', roots).categoryId, 'development_repo');
    assert.equal(classifySuitePath('C:\\suite\\docs\\PROJECT-ARCHITECTURE.md', roots).categoryId, 'documentation');
    assert.equal(classifySuitePath('C:\\suite\\AGENTS.md', roots).categoryId, 'rules');
    assert.equal(classifySuitePath('C:\\suite\\config\\mcp.d\\unity-mcp.json', roots).categoryId, 'rules');
    assert.equal(classifySuitePath('C:\\suite\\release\\portable\\AGENTS.md', roots).categoryId, 'release_artifact');
    assert.equal(classifySuitePath('C:\\Users\\admin\\.codex\\skills\\claude-to-im\\dist\\daemon.mjs', roots).categoryId, 'live_skill');
    assert.equal(classifySuitePath('E:\\cli-md\\data\\todos\\direct-reminders\\note.md', roots).categoryId, 'memory_repo');
    assert.equal(classifySuitePath('C:\\Users\\admin\\.claude-to-im\\data\\messages\\session.jsonl', roots).categoryId, 'runtime_data');
    assert.equal(classifySuitePath('C:\\Users\\admin\\.claude-to-im\\runtime\\workflow-runs.json', roots).categoryId, 'runtime_data');
    assert.equal(classifySuitePath('C:\\Users\\admin\\.claude-to-im\\logs\\bridge.log', roots).categoryId, 'logs');
    assert.equal(classifySuitePath('C:\\suite\\.codepilot-uploads\\sticker-candidate-fileKey.png', roots).categoryId, 'temporary_upload_cache');
  });

  it('exposes prompt policy text from the registry without hardcoded robot names', () => {
    const lines = getAgentPolicyPromptLines([
      'agent_kernel.proactive_completion',
      'capability_router.existing_sticker_delivery',
      'memory_system.partitioned_memory_intent',
    ]);

    assert.match(lines.join('\n'), /Proactive completion policy/i);
    assert.match(lines.join('\n'), /minimal missing detail/i);
    assert.match(lines.join('\n'), /existing, verified sticker/i);
    assert.match(lines.join('\n'), /must not substitute image generation/i);
    assert.match(lines.join('\n'), /do not read skills, call tools, or create assets/i);
    assert.match(lines.join('\n'), /Memory partition policy/i);
    assert.match(lines.join('\n'), /must not write durable memory/i);
    assert.match(lines.join('\n'), /Do not use github-memory-protocol/i);
    assert.match(lines.join('\n'), /controlled v2 memory write evidence/i);
    assert.match(lines.join('\n'), /clarification/i);
    assert.doesNotMatch(lines.join('\n'), /小虾米|小桥|mavis/iu);
  });

  it('assigns structured turn evidence and reference resolution to the Context Broker', () => {
    const compiled = compileAgentArchitectureRegistry();
    const policy = compiled.policies.find((item) => item.id === 'context_broker.reference_resolution');

    assert.ok(policy);
    assert.equal(policy.layerId, 'context_broker');
    assert.match(policy.responsibility, /structured|evidence|reference/i);
    assert.ok(policy.tags.includes('reply'));
    assert.ok(policy.tags.includes('resolution'));
  });
  it('keeps slash command role gates in the policy registry', () => {
    for (const command of ['/new', '/bind', '/cwd', '/mode', '/status', '/docs', '/projects', '/sessions', '/stop']) {
      assert.equal(getSlashCommandRequiredRole(command), 'operator', command);
    }
    assert.equal(getSlashCommandRequiredRole('/feishu'), 'owner');
    assert.equal(getSlashCommandRequiredRole('/whoami'), null);
    assert.equal(getSlashCommandRequiredRole('/remind'), null);
    assert.equal(getSlashCommandRequiredRole('/unknown'), null);
  });

  it('keeps permission risk gates in the policy registry', () => {
    assert.equal(isHighRiskPermissionToolName('Read'), false);
    assert.equal(isHighRiskPermissionToolName('Bash'), true);
    assert.equal(isHighRiskPermissionInput('{"cmd":"rm -rf ./dist"}'), true);
    assert.equal(getPermissionApprovalRequiredRole({ toolName: 'Read', toolInputJson: '{"file":"README.md"}' }), 'operator');
    assert.equal(getPermissionApprovalRequiredRole({ toolName: 'Bash', toolInputJson: '{"cmd":"npm install"}' }), 'owner');
    assert.equal(getPermissionApprovalRequiredRole({ toolName: 'mcp.direct-message', toolInputJson: '{"target":"chat"}' }), 'owner');
  });

  it('keeps dangerous request and reminder side-effect gates in the policy registry', () => {
    assert.equal(isDangerousUserRequest('日志里写着 rm -rf 执行失败'), false);
    assert.equal(isDangerousUserRequest('请删除这个目录'), true);
    assert.equal(isSystemAffectingReminderRequest('提醒我十分钟后喝水'), false);
    assert.equal(isSystemAffectingReminderRequest('十分钟后关闭屏幕'), true);
    assert.equal(isSystemAffectingReminderRequest('提醒我', '发送这个文件给别人'), true);
  });

  it('keeps broadcast audiences and instruction objects out of addressable mention targets', () => {
    assert.equal(isNonAddressableMentionTarget('各位飞书机器人'), true);
    assert.equal(isNonAddressableMentionTarget('所有的其他机器人'), true);
    assert.equal(isNonAddressableMentionTarget('按这个格式'), true);
    assert.equal(isNonAddressableMentionTarget('乔治'), false);
  });

  it('decides skill autonomy from source and risk instead of names', () => {
    assert.equal(decideSkillLifecycleAction({ installed: true, sourceClass: 'installed', risk: 'low', changeKind: 'none' }), 'use');
    assert.equal(decideSkillLifecycleAction({ installed: false, sourceClass: 'official_curated', risk: 'low', changeKind: 'install' }), 'confirm_user');
    assert.equal(decideSkillLifecycleAction({ installed: false, sourceClass: 'whitelist', risk: 'low', changeKind: 'install' }), 'auto_install');
    assert.equal(decideSkillLifecycleAction({ installed: false, sourceClass: 'self_created', risk: 'low', changeKind: 'install' }), 'confirm_user');
    assert.equal(decideSkillLifecycleAction({ installed: false, sourceClass: 'third_party', risk: 'medium', changeKind: 'install' }), 'confirm_owner');
    assert.equal(decideSkillLifecycleAction({ installed: true, sourceClass: 'whitelist', risk: 'high', changeKind: 'permissions' }), 'confirm_owner');
    assert.equal(decideSkillLifecycleAction({ installed: true, sourceClass: 'third_party', risk: 'medium', changeKind: 'none' }), 'use');
    assert.equal(decideSkillLifecycleAction({ installed: true, sourceClass: 'whitelist', risk: 'low', changeKind: 'trigger' }), 'confirm_user');
  });

  it('searches external skills only for a real unmet capability requirement', () => {
    assert.equal(shouldSearchSkillCatalog({ taskRequiresCapability: false, installedCandidateCount: 0 }), false);
    assert.equal(shouldSearchSkillCatalog({ taskRequiresCapability: true, installedCandidateCount: 1 }), false);
    assert.equal(shouldSearchSkillCatalog({ taskRequiresCapability: true, installedCandidateCount: 0 }), true);
  });
});
