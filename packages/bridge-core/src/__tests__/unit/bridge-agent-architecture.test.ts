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
      'policy_registry.scheduled_task_actions',
      'policy_registry.artifact_promotion',
      'memory_system.partitioned_memory_intent',
    ]);

    assert.match(lines.join('\n'), /Proactive completion policy/i);
    assert.match(lines.join('\n'), /minimal missing detail/i);
    assert.match(lines.join('\n'), /existing, verified sticker/i);
    assert.match(lines.join('\n'), /must not substitute image generation/i);
    assert.match(lines.join('\n'), /do not read skills, call tools, or create assets/i);
    assert.match(lines.join('\n'), /cti-scheduled-task/i);
    assert.match(lines.join('\n'), /periodic|recurring|周期/i);
    assert.match(lines.join('\n'), /Host success/i);
    assert.match(lines.join('\n'), /cti-artifact-promote/i);
    assert.match(lines.join('\n'), /artifactId.*targetProjectId.*targetRelativePath.*expectedSha256/i);
    assert.match(lines.join('\n'), /Owner/i);
    assert.match(lines.join('\n'), /Memory partition policy/i);
    assert.match(lines.join('\n'), /must not write durable memory/i);
    assert.match(lines.join('\n'), /Do not use github-memory-protocol/i);
    assert.match(lines.join('\n'), /controlled memory v3 write evidence/i);
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

  it('keeps Feishu least-privilege authorization in the Policy Registry', () => {
    const compiled = compileAgentArchitectureRegistry();
    const policy = compiled.policies.find((item) => item.id === 'policy_registry.feishu_permission_minimization');
    const lines = getAgentPolicyPromptLines(['policy_registry.feishu_permission_minimization']).join('\n');

    assert.ok(policy);
    assert.equal(policy.layerId, 'policy_registry');
    assert.match(lines, /bot\/application identity first/i);
    assert.match(lines, /compatible alternatives/i);
    assert.match(lines, /one exact --scope/i);
    assert.match(lines, /--recommend/i);
    assert.match(lines, /administrator action/i);
    assert.match(lines, /ask before/i);
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

  it('allows explicit names and evidence-bound contextual targets to reach adaptive mention resolution', () => {
    const lines = getAgentPolicyPromptLines(['policy_registry.outbound_mention_targets']).join('\n');

    assert.match(lines, /resolve the current assistant, starter, current turn, and unique counterparty before provider execution/i);
    assert.match(lines, /starter name describes the speaker role, not the outbound mention target/i);
    assert.match(lines, /current-turn explicit request/i);
    assert.match(lines, /real current-turn evidence/i);
    assert.match(lines, /他、她、对方/);
    assert.match(lines, /verifies by platform ID/i);
    assert.match(lines, /balanced\/fluent profile/i);
    assert.match(lines, /strong attributable platform evidence/i);
    assert.match(lines, /bot-to-bot return mention/i);
    assert.match(lines, /sender app_id or open_id\/user_id\/union_id.*mentionable member_id/i);
    assert.match(lines, /conflicting identities fail closed/i);
    assert.match(lines, /may select a real evidence ID/i);
    assert.match(lines, /Invented IDs/i);
    assert.match(lines, /broadcast audiences/i);
  });

  it('assigns persistent chat workspace switching to the Policy Registry', () => {
    const compiled = compileAgentArchitectureRegistry();
    const policy = compiled.policies.find((item) => item.id === 'policy_registry.workspace_binding');

    assert.ok(policy);
    assert.equal(policy.layerId, 'policy_registry');
    assert.match(policy.responsibility, /Owner/i);
    assert.match(policy.responsibility, /registered project/i);
    assert.ok(policy.tags.includes('session-binding'));
  });

  it('keeps Feishu text presentation rules in the Delivery Layer', () => {
    const compiled = compileAgentArchitectureRegistry();
    const policy = compiled.policies.find((item) => item.id === 'delivery_layer.feishu_text_presentation');
    const lines = getAgentPolicyPromptLines(['delivery_layer.feishu_text_presentation']).join('\n');

    assert.ok(policy);
    assert.equal(policy.layerId, 'delivery_layer');
    assert.match(lines, /independent information groups/i);
    assert.match(lines, /blockquotes/i);
    assert.match(lines, /bold/i);
    assert.match(lines, /italic/i);
    assert.match(lines, /underline/i);
    assert.match(lines, /short conversational replies/i);
    assert.match(lines, /omit the header entirely/i);
    assert.match(lines, /verified native reaction\/sticker delivery/i);
  });

  it('keeps finite user choices in the Delivery Layer without weakening safety gates', () => {
    const compiled = compileAgentArchitectureRegistry();
    const policy = compiled.policies.find((item) => item.id === 'delivery_layer.structured_choice_prompt');
    const lines = getAgentPolicyPromptLines(['delivery_layer.structured_choice_prompt']).join('\n');

    assert.ok(policy);
    assert.equal(policy.layerId, 'delivery_layer');
    assert.match(lines, /2-8 concrete/i);
    assert.match(lines, /choices.*cti-final/i);
    assert.match(lines, /full path or identifier/i);
    assert.match(lines, /permission approval/i);
    assert.match(lines, /Owner confirmation/i);
    assert.match(lines, /callback_data/i);
    assert.match(lines, /Bridge signs button callbacks/i);
  });

  it('keeps input evidence separate from output attachments in the Delivery Layer', () => {
    const compiled = compileAgentArchitectureRegistry();
    const policy = compiled.policies.find((item) => item.id === 'delivery_layer.result_envelope');
    const lines = getAgentPolicyPromptLines(['delivery_layer.result_envelope']).join('\n');

    assert.ok(policy);
    assert.equal(policy.layerId, 'delivery_layer');
    assert.match(lines, /input evidence/i);
    assert.match(lines, /actual result objective/i);
    assert.match(lines, /not a fixed phrase or a filename/i);
    assert.match(lines, /generated, edited, annotated, converted, or exported/i);
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
