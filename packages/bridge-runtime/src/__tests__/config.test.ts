import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecret, configToSettings, type Config } from '../config.js';

// ── maskSecret ──

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret(''), '****');
  });

  it('preserves last 4 chars for longer values', () => {
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });

  it('handles exactly 5 chars', () => {
    assert.equal(maskSecret('12345'), '*2345');
  });
});

// ── configToSettings ──

describe('configToSettings', () => {
  const base: Config = {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
  };

  it('always sets remote_bridge_enabled to true', () => {
    const m = configToSettings(base);
    assert.equal(m.get('remote_bridge_enabled'), 'true');
    assert.equal(m.get('bridge_safety_policy_profile'), 'balanced');
  });

  it('projects the selected adaptive safety profile into bridge settings', () => {
    const m = configToSettings({ ...base, safetyPolicyProfile: 'fluent' });
    assert.equal(m.get('bridge_safety_policy_profile'), 'fluent');
  });

  it('sets channel enabled flags based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['telegram', 'discord'] });
    assert.equal(m.get('bridge_telegram_enabled'), 'true');
    assert.equal(m.get('bridge_discord_enabled'), 'true');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
  });

  it('maps telegram config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['telegram'],
      tgBotToken: 'bot123:abc',
      tgAllowedUsers: ['user1', 'user2'],
      tgChatId: '99999',
    });
    assert.equal(m.get('telegram_bot_token'), 'bot123:abc');
    assert.equal(m.get('telegram_bridge_allowed_users'), 'user1,user2');
    assert.equal(m.get('telegram_chat_id'), '99999');
  });

  it('maps discord config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['discord'],
      discordBotToken: 'discord-token',
      discordAllowedUsers: ['u1'],
      discordAllowedChannels: ['c1', 'c2'],
      discordAllowedGuilds: ['g1'],
    });
    assert.equal(m.get('bridge_discord_bot_token'), 'discord-token');
    assert.equal(m.get('bridge_discord_allowed_users'), 'u1');
    assert.equal(m.get('bridge_discord_allowed_channels'), 'c1,c2');
    assert.equal(m.get('bridge_discord_allowed_guilds'), 'g1');
  });

  it('maps feishu config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['feishu'],
      feishuAppId: 'app-id',
      feishuAppSecret: 'app-secret',
      feishuDomain: 'example.com',
      feishuAllowedUsers: ['fu1'],
      feishuGrantedScopes: ['im:message', 'docx:document:readonly'],
      feishuOAuthMode: 'manual',
      feishuOAuthPublicBaseUrl: 'https://bot.example.com',
      feishuOAuthManualRedirectUri: 'http://127.0.0.1:17321/feishu/oauth/callback',
      feishuOAuthCallbackPath: '/feishu/oauth/callback',
      feishuOAuthScopes: ['offline_access', 'docx:document:readonly'],
      feishuCloudMaxChars: 80000,
      feishuCloudMaxRows: 500,
      feishuCloudMaxRecords: 500,
      feishuCloudMaxSheets: 5,
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_domain'), 'example.com');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
    assert.equal(m.get('bridge_feishu_granted_scopes'), 'im:message,docx:document:readonly');
    assert.equal(m.get('bridge_feishu_oauth_mode'), 'manual');
    assert.equal(m.get('bridge_feishu_oauth_public_base_url'), 'https://bot.example.com');
    assert.equal(m.get('bridge_feishu_oauth_manual_redirect_uri'), 'http://127.0.0.1:17321/feishu/oauth/callback');
    assert.equal(m.get('bridge_feishu_oauth_callback_path'), '/feishu/oauth/callback');
    assert.equal(m.get('bridge_feishu_oauth_scopes'), 'offline_access,docx:document:readonly');
    assert.equal(m.get('bridge_feishu_cloud_max_chars'), '80000');
    assert.equal(m.get('bridge_feishu_cloud_max_rows'), '500');
    assert.equal(m.get('bridge_feishu_cloud_max_records'), '500');
    assert.equal(m.get('bridge_feishu_cloud_max_sheets'), '5');
  });

  it('sets bridge_qq_enabled based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['qq'] });
    assert.equal(m.get('bridge_qq_enabled'), 'true');
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
  });

  it('defaults bridge_qq_enabled to false', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_qq_enabled'), 'false');
  });

  it('maps qq config fields', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'qq-app-id',
      qqAppSecret: 'qq-secret',
      qqAllowedUsers: ['openid1', 'openid2'],
    });
    assert.equal(m.get('bridge_qq_app_id'), 'qq-app-id');
    assert.equal(m.get('bridge_qq_app_secret'), 'qq-secret');
    assert.equal(m.get('bridge_qq_allowed_users'), 'openid1,openid2');
  });

  it('maps qq image settings', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
      qqImageEnabled: false,
      qqMaxImageSize: 10,
    });
    assert.equal(m.get('bridge_qq_image_enabled'), 'false');
    assert.equal(m.get('bridge_qq_max_image_size'), '10');
  });

  it('maps weixin settings', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['weixin'],
      weixinBaseUrl: 'https://example.weixin.test',
      weixinCdnBaseUrl: 'https://cdn.weixin.test',
      weixinMediaEnabled: true,
    });
    assert.equal(m.get('bridge_weixin_enabled'), 'true');
    assert.equal(m.get('bridge_weixin_base_url'), 'https://example.weixin.test');
    assert.equal(m.get('bridge_weixin_cdn_base_url'), 'https://cdn.weixin.test');
    assert.equal(m.get('bridge_weixin_media_enabled'), 'true');
  });

  it('omits qq image settings when not set', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['qq'],
      qqAppId: 'id',
      qqAppSecret: 'secret',
    });
    assert.equal(m.has('bridge_qq_image_enabled'), false);
    assert.equal(m.has('bridge_qq_max_image_size'), false);
  });

  it('maps workdir and mode, omits model when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_default_work_dir'), '/tmp/test');
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.get('bridge_default_mode'), 'code');
  });

  it('maps model when explicitly set', () => {
    const m = configToSettings({ ...base, defaultModel: 'gpt-4o' });
    assert.equal(m.get('bridge_default_model'), 'gpt-4o');
    assert.equal(m.get('default_model'), 'gpt-4o');
  });

  it('maps non-default mode', () => {
    const m = configToSettings({ ...base, defaultMode: 'plan' });
    assert.equal(m.get('bridge_default_mode'), 'plan');
  });

  it('maps workspace roots but does not expose legacy additional directories to the bridge', () => {
    const m = configToSettings({
      ...base,
      allowedWorkspaceRoots: ['C:\\Users\\admin\\Documents\\New project', 'E:\\cli-md', 'F:\\unity'],
      codexAdditionalDirectories: ['E:\\cli-md', 'F:\\unity'],
      selfOptimizeOnFailure: true,
    });
    assert.equal(
      m.get('bridge_allowed_workspace_roots'),
      'C:\\Users\\admin\\Documents\\New project;E:\\cli-md;F:\\unity',
    );
    assert.equal(m.has('bridge_default_additional_directories'), false);
    assert.equal(m.get('bridge_self_optimize_on_failure'), 'true');
  });

  it('maps Ollama routing config and keeps legacy local router keys as compatibility settings', () => {
    const m = configToSettings({
      ...base,
      ollamaEnabled: true,
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen2.5-coder:7b',
      ollamaTimeoutMs: 45000,
      localLlmAutoRoute: true,
      localLlmFallbackToCodex: true,
      localLlmRouterEnabled: true,
      localLlmRouterMode: 'hybrid',
      localLlmForceHub: true,
      localLlmRouterMaxInputChars: 5200,
      localLlmRouterMaxHistoryItems: 6,
      localLlmRouterTimeoutMs: 12000,
      localLlmMaxInputChars: 5000,
      localLlmMaxOutputTokens: 768,
      localLlmComplexityMode: 'conservative',
      lightChatFastPathEnabled: true,
      lightChatFastPathTimeoutMs: 2000,
      providerCircuitCooldownMs: 60000,
      memoryIntentTimeoutMs: 4000,
      lightChatHistoryLimit: 2,
      lightChatMaxInputChars: 280,
    });
    assert.equal(m.get('bridge_ollama_enabled'), 'true');
    assert.equal(m.get('bridge_ollama_base_url'), 'http://127.0.0.1:11434');
    assert.equal(m.get('bridge_ollama_model'), 'qwen2.5-coder:7b');
    assert.equal(m.get('bridge_ollama_timeout_ms'), '45000');
    assert.equal(m.get('bridge_local_llm_enabled'), 'true');
    assert.equal(m.get('bridge_local_llm_base_url'), 'http://127.0.0.1:11434');
    assert.equal(m.get('bridge_local_llm_model'), 'qwen2.5-coder:7b');
    assert.equal(m.get('bridge_local_llm_auto_route'), 'true');
    assert.equal(m.get('bridge_local_llm_fallback_to_codex'), 'true');
    assert.equal(m.get('bridge_local_llm_router_enabled'), 'true');
    assert.equal(m.get('bridge_local_llm_router_mode'), 'hybrid');
    assert.equal(m.get('bridge_local_llm_force_hub'), 'true');
    assert.equal(m.get('bridge_local_llm_router_max_input_chars'), '5200');
    assert.equal(m.get('bridge_local_llm_router_max_history_items'), '6');
    assert.equal(m.get('bridge_local_llm_router_timeout_ms'), '12000');
    assert.equal(m.get('bridge_local_llm_max_input_chars'), '5000');
    assert.equal(m.get('bridge_local_llm_max_output_tokens'), '768');
    assert.equal(m.get('bridge_local_llm_complexity_mode'), 'conservative');
    assert.equal(m.get('bridge_light_chat_fast_path_enabled'), 'true');
    assert.equal(m.get('bridge_light_chat_fast_path_timeout_ms'), '2000');
    assert.equal(m.get('bridge_provider_circuit_cooldown_ms'), '60000');
    assert.equal(m.get('bridge_memory_intent_timeout_ms'), '4000');
    assert.equal(m.get('bridge_light_chat_history_limit'), '2');
    assert.equal(m.get('bridge_light_chat_max_input_chars'), '280');
  });

  it('maps generic local AI and Codex API settings without exposing secrets in normal settings', () => {
    const m = configToSettings({
      ...base,
      ollamaEnabled: true,
      localAiKind: 'openai-compatible',
      localAiBaseUrl: 'http://127.0.0.1:1234',
      localAiModel: 'local-model',
      localAiApiKey: 'local-secret-abcd',
      localAiTimeoutMs: 30000,
      codexBaseUrl: 'https://api.example.test/v1',
      codexApiKey: 'codex-secret-wxyz',
      codexModel: 'gpt-local',
      codexPassModel: true,
      codexReasoningEffort: 'low',
      codexInheritGlobalMcp: true,
      codexModelSource: 'external_api',
      codexRoutingMode: 'auto_failover',
      codexApiFallbackChain: ['local_api', 'external_api'],
      codexFailoverCandidateTimeoutMs: 2500,
      defaultExecutorId: 'mavis-agent',
      memoryOptimizerEnabled: true,
      memoryOptimizerIntervalDays: 7,
      memoryOptimizerModelSource: 'codex_primary',
    });

    assert.equal(m.get('bridge_local_ai_kind'), 'openai-compatible');
    assert.equal(m.get('bridge_local_ai_base_url'), 'http://127.0.0.1:1234');
    assert.equal(m.get('bridge_local_ai_model'), 'local-model');
    assert.equal(m.get('bridge_local_ai_api_key_set'), 'true');
    assert.equal(m.get('bridge_local_ai_api_key_masked'), '*************abcd');
    assert.equal(m.get('bridge_local_ai_timeout_ms'), '30000');
    assert.equal(m.get('bridge_local_llm_base_url'), 'http://127.0.0.1:1234');
    assert.equal(m.get('bridge_local_llm_model'), 'local-model');
    assert.equal(m.get('bridge_codex_base_url'), 'https://api.example.test/v1');
    assert.equal(m.get('bridge_codex_api_key_set'), 'true');
    assert.equal(m.get('bridge_codex_api_key_masked'), '*************wxyz');
    assert.equal(m.get('bridge_codex_model'), 'gpt-local');
    assert.equal(m.get('bridge_codex_pass_model'), 'true');
    assert.equal(m.get('bridge_codex_reasoning_effort'), 'low');
    assert.equal(m.get('bridge_codex_inherit_global_mcp'), 'true');
    assert.equal(m.get('bridge_codex_model_source'), 'external_api');
    assert.equal(m.get('bridge_codex_routing_mode'), 'auto_failover');
    assert.equal(m.get('bridge_codex_api_fallback_chain'), 'local_api,external_api');
    assert.equal(m.get('bridge_codex_failover_candidate_timeout_ms'), '2500');
    assert.equal(m.get('bridge_default_executor_id'), 'mavis-agent');
    assert.equal(m.has('bridge_codex_local_fallback_enabled'), false);
    assert.equal(m.has('bridge_codex_local_fallback_reasoning_effort'), false);
    assert.equal(m.has('bridge_codex_failure_fallback_mode'), false);
    assert.equal(m.has('bridge_local_agent_mode'), false);
    assert.equal(m.has('bridge_local_tool_call_required'), false);
    assert.equal(m.has('bridge_execution_required_route'), false);
    assert.equal(m.get('bridge_memory_optimizer_enabled'), 'true');
    assert.equal(m.get('bridge_memory_optimizer_interval_days'), '7');
    assert.equal(m.get('bridge_memory_optimizer_model_source'), 'codex_primary');
    assert.equal(Array.from(m.values()).some((value) => value.includes('local-secret-abcd')), false);
    assert.equal(Array.from(m.values()).some((value) => value.includes('codex-secret-wxyz')), false);
  });

  it('omits optional fields when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('telegram_bot_token'), false);
    assert.equal(m.has('bridge_discord_bot_token'), false);
    assert.equal(m.has('bridge_feishu_app_id'), false);
  });

  it('maps todo push config and defaults it to disabled', () => {
    const defaultSettings = configToSettings(base);
    assert.equal(defaultSettings.get('bridge_todo_push_enabled'), 'false');
    assert.equal(defaultSettings.get('bridge_todo_push_channels'), 'feishu');

    const m = configToSettings({
      ...base,
      todoPushEnabled: true,
      todoPushPollMs: 30000,
      todoPushWindowMs: 600000,
      todoPushChannels: ['feishu', 'weixin'],
    });
    assert.equal(m.get('bridge_todo_push_enabled'), 'true');
    assert.equal(m.get('bridge_todo_push_poll_ms'), '30000');
    assert.equal(m.get('bridge_todo_push_window_ms'), '600000');
    assert.equal(m.get('bridge_todo_push_channels'), 'feishu,weixin');
  });

  it('maps scheduled task runtime limits', () => {
    const m = configToSettings({
      ...base,
      scheduledTasksEnabled: true,
      scheduledTasksPollMs: 15000,
      scheduledTasksMaxConcurrentRuns: 4,
      scheduledTasksFailureAlertAfter: 3,
      scheduledTasksFailureAlertCooldownMs: 3600000,
    });
    assert.equal(m.get('bridge_scheduled_tasks_enabled'), 'true');
    assert.equal(m.get('bridge_scheduled_tasks_poll_ms'), '15000');
    assert.equal(m.get('bridge_scheduled_tasks_max_concurrent_runs'), '4');
    assert.equal(m.get('bridge_scheduled_tasks_failure_alert_after'), '3');
    assert.equal(m.get('bridge_scheduled_tasks_failure_alert_cooldown_ms'), '3600000');
  });
});

// ── Config file parsing (loadConfig/saveConfig round-trip) ──

describe('loadConfig/saveConfig round-trip', () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-test-'));
    origHome = process.env.HOME || '';
    // We can't easily override CTI_HOME since it's a const,
    // so we test the parsing logic indirectly through configToSettings
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('configToSettings returns correct defaults', () => {
    const m = configToSettings({
      runtime: 'claude',
      enabledChannels: [],
      defaultWorkDir: process.cwd(),
      defaultMode: 'code',
    });
    assert.equal(m.get('bridge_telegram_enabled'), 'false');
    assert.equal(m.get('bridge_discord_enabled'), 'false');
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
    assert.equal(m.get('bridge_qq_enabled'), 'false');
    assert.equal(m.get('bridge_weixin_enabled'), 'false');
  });

  it('uses config.env as the runtime process environment source after restart', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-runtime-env-config-'));
    const previousCtiHome = process.env.CTI_HOME;
    const previousReasoningEffort = process.env.CTI_CODEX_REASONING_EFFORT;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_CODEX_REASONING_EFFORT=xhigh',
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;
      process.env.CTI_CODEX_REASONING_EFFORT = 'low';

      const module = await import(`../config.js?runtime-env-${Date.now()}`);
      module.hydrateProcessEnvironmentFromConfigFile();
      const config = module.loadConfig();

      assert.equal(config.codexReasoningEffort, 'xhigh');
      assert.equal(process.env.CTI_CODEX_REASONING_EFFORT, 'xhigh');
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      if (previousReasoningEffort === undefined) delete process.env.CTI_CODEX_REASONING_EFFORT;
      else process.env.CTI_CODEX_REASONING_EFFORT = previousReasoningEffort;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('loads adaptive safety profiles and falls back invalid values to balanced', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-safety-profile-config-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_SAFETY_POLICY_PROFILE=fluent',
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;
      const fluentModule = await import(`../config.js?safety-profile-${Date.now()}`);
      assert.equal(fluentModule.loadConfig().safetyPolicyProfile, 'fluent');

      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_SAFETY_POLICY_PROFILE=disable_everything',
      ].join('\n'), 'utf-8');
      const fallbackModule = await import(`../config.js?safety-profile-invalid-${Date.now()}`);
      assert.equal(fallbackModule.loadConfig().safetyPolicyProfile, 'balanced');
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('does not use deprecated llama.cpp endpoint and GGUF model as Ollama runtime source', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-legacy-ollama-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_DEFAULT_WORKDIR=C:\\unity\\ST3',
        'CTI_LOCAL_LLM_ENABLED=true',
        'CTI_LOCAL_LLM_BASE_URL=http://127.0.0.1:8080',
        'CTI_LOCAL_LLM_MODEL=Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
        'CTI_LOCAL_LLM_TIMEOUT_MS=45000',
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?legacy-ollama-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.ollamaEnabled, true);
      assert.equal(config.ollamaBaseUrl, 'http://127.0.0.1:11434');
      assert.equal(config.ollamaModel, 'qwen2.5-coder:7b');
      assert.equal(config.localLlmBaseUrl, 'http://127.0.0.1:11434');
      assert.equal(config.localLlmModel, 'qwen2.5-coder:7b');
      assert.equal(config.localLlmTimeoutMs, 45000);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('prefers CTI_LOCAL_AI settings over legacy CTI_OLLAMA settings', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-ai-config-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_DEFAULT_WORKDIR=C:\\unity\\ST3',
        'CTI_OLLAMA_BASE_URL=http://127.0.0.1:11434',
        'CTI_OLLAMA_MODEL=qwen2.5-coder:7b',
        'CTI_LOCAL_AI_KIND=openai-compatible',
        'CTI_LOCAL_AI_BASE_URL=http://127.0.0.1:1234',
        'CTI_LOCAL_AI_MODEL=lmstudio-model',
        'CTI_LOCAL_AI_API_KEY=local-secret',
        'CTI_LOCAL_AI_TIMEOUT_MS=30000',
        'CTI_CODEX_BASE_URL=https://codex.example.test/v1',
        'CTI_CODEX_API_KEY=codex-secret',
        'CTI_CODEX_MODEL=gpt-local',
        'CTI_CODEX_PASS_MODEL=true',
        'CTI_CODEX_REASONING_EFFORT=medium',
        'CTI_CODEX_INHERIT_GLOBAL_MCP=true',
        'CTI_CODEX_MODEL_SOURCE=external_api',
        'CTI_DEFAULT_EXECUTOR_ID=mavis-agent',
        'CTI_MAVIS_BRIDGE_SESSION_ID=mvs_parent',
        'CTI_CODEX_LOCAL_FALLBACK_ENABLED=true',
        'CTI_CODEX_LOCAL_FALLBACK_REASONING_EFFORT=low',
        'CTI_CODEX_FAILURE_FALLBACK_MODE=local_agent',
        'CTI_LOCAL_AGENT_MODE=agent_verified',
        'CTI_LOCAL_TOOL_CALL_REQUIRED=false',
        'CTI_EXECUTION_REQUIRED_ROUTE=refuse',
        'CTI_MEMORY_OPTIMIZER_ENABLED=true',
        'CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS=9',
        'CTI_MEMORY_OPTIMIZER_MODEL_SOURCE=local_ai',
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?local-ai-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.localAiKind, 'openai-compatible');
      assert.equal(config.localAiBaseUrl, 'http://127.0.0.1:1234');
      assert.equal(config.localAiModel, 'lmstudio-model');
      assert.equal(config.localAiApiKey, 'local-secret');
      assert.equal(config.localAiTimeoutMs, 30000);
      assert.equal(config.ollamaBaseUrl, 'http://127.0.0.1:1234');
      assert.equal(config.ollamaModel, 'lmstudio-model');
      assert.equal(config.codexBaseUrl, 'https://codex.example.test/v1');
      assert.equal(config.codexApiKey, 'codex-secret');
      assert.equal(config.codexModel, 'gpt-local');
      assert.equal(config.codexPassModel, true);
      assert.equal(config.codexReasoningEffort, 'medium');
      assert.equal(config.codexInheritGlobalMcp, true);
      assert.equal(config.codexModelSource, 'external_api');
      assert.equal(config.defaultExecutorId, 'mavis-agent');
      assert.equal(config.mavisBridgeSessionId, 'mvs_parent');
      assert.equal('codexLocalFallbackEnabled' in config, false);
      assert.equal('codexLocalFallbackReasoningEffort' in config, false);
      assert.equal('codexFailureFallbackMode' in config, false);
      assert.equal('localAgentMode' in config, false);
      assert.equal('localToolCallRequired' in config, false);
      assert.equal('executionRequiredRoute' in config, false);
      assert.equal(config.memoryOptimizerEnabled, true);
      assert.equal(config.memoryOptimizerIntervalDays, 9);
      assert.equal(config.memoryOptimizerModelSource, 'local_ai');
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('loads todo push env config', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-todo-push-config-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_DEFAULT_WORKDIR=C:\\unity\\ST3',
        'CTI_TODO_PUSH_ENABLED=true',
        'CTI_TODO_PUSH_POLL_MS=30000',
        'CTI_TODO_PUSH_WINDOW_MS=600000',
        'CTI_TODO_PUSH_CHANNELS=feishu,weixin',
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?todo-push-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.todoPushEnabled, true);
      assert.equal(config.todoPushPollMs, 30000);
      assert.equal(config.todoPushWindowMs, 600000);
      assert.deepEqual(config.todoPushChannels, ['feishu', 'weixin']);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('loads and bounds scheduled task env config', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-task-config-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_DEFAULT_WORKDIR=C:\\unity\\ST3',
        'CTI_SCHEDULED_TASKS_ENABLED=true',
        'CTI_SCHEDULED_TASKS_POLL_MS=1000',
        'CTI_SCHEDULED_TASKS_MAX_CONCURRENT_RUNS=99',
        'CTI_SCHEDULED_TASKS_FAILURE_ALERT_AFTER=3',
        'CTI_SCHEDULED_TASKS_FAILURE_ALERT_COOLDOWN_MS=3600000',
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?scheduled-tasks-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.scheduledTasksEnabled, true);
      assert.equal(config.scheduledTasksPollMs, 5000);
      assert.equal(config.scheduledTasksMaxConcurrentRuns, 16);
      assert.equal(config.scheduledTasksFailureAlertAfter, 3);
      assert.equal(config.scheduledTasksFailureAlertCooldownMs, 3600000);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('keeps memory repository independent from legacy Unity project path', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-repo-config-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-repo-work-'));
    const unityProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-repo-unity-'));
    const memoryRepo = path.join(unityProject, 'memory-artifacts');
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        `CTI_DEFAULT_WORKDIR=${workDir}`,
        `CTI_UNITY_PROJECT_PATH=${unityProject}`,
        `CTI_MEMORY_REPO_DIR=${memoryRepo}`,
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?memory-repo-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.memoryRepoDir, path.resolve(memoryRepo));
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(unityProject, { recursive: true, force: true });
    }
  });

  it('raises legacy four-second memory intent timeouts above cold classifier startup latency', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-intent-timeout-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_DEFAULT_WORKDIR=C:\\unity\\ST3',
        'CTI_MEMORY_INTENT_TIMEOUT_MS=4000',
      ].join('\n'), 'utf8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?memory-intent-timeout-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.memoryIntentTimeoutMs, 30000);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('does not merge legacy Codex additional directories into allowed workspace roots', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-workspace-root-config-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-workspace-root-default-'));
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-workspace-root-allowed-'));
    const legacyExtra = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-workspace-root-legacy-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        `CTI_DEFAULT_WORKDIR=${workDir}`,
        `CTI_ALLOWED_WORKSPACE_ROOTS=${allowedDir}`,
        `CTI_CODEX_ADDITIONAL_DIRECTORIES=${legacyExtra}`,
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?workspace-roots-${Date.now()}`);
      const config = module.loadConfig();

      assert.deepEqual(config.allowedWorkspaceRoots, [workDir, allowedDir]);
      assert.deepEqual(config.codexAdditionalDirectories, [legacyExtra]);
      assert.equal(module.configToSettings(config).has('bridge_default_additional_directories'), false);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(allowedDir, { recursive: true, force: true });
      fs.rmSync(legacyExtra, { recursive: true, force: true });
    }
  });

  it('loads structured projects while preserving legacy allowed roots as compatibility records', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-registry-config-'));
    const structuredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-registry-structured-'));
    const unityRoot = path.join(structuredRoot, 'Game');
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-registry-legacy-'));
    const registryPath = path.join(configDir, 'projects.json');
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.mkdirSync(unityRoot, { recursive: true });
      fs.writeFileSync(registryPath, `${JSON.stringify({
        schema: 'codex-im-suite/project-registry/v1',
        projects: [{
          id: 'unity-project',
          displayName: 'Unity Project',
          type: 'unity',
          workspaceRoot: structuredRoot,
          unityProjectRoot: unityRoot,
          accessMode: 'read_write',
          enabled: true,
        }],
      }, null, 2)}\n`, 'utf8');
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        `CTI_DEFAULT_WORKDIR=${structuredRoot}`,
        `CTI_ALLOWED_WORKSPACE_ROOTS=${legacyRoot}`,
        `CTI_PROJECT_REGISTRY_PATH=${registryPath}`,
      ].join('\n'), 'utf8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?project-registry-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.projectRegistryPath, registryPath);
      assert.deepEqual(config.registeredProjects.map((item: { id: string }) => item.id)[0], 'unity-project');
      assert.equal(config.registeredProjects.length, 2);
      assert.equal(config.registeredProjects[1].workspaceRoot, legacyRoot);
      assert.equal(module.configToSettings(config).get('bridge_project_registry_path'), registryPath);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(structuredRoot, { recursive: true, force: true });
      fs.rmSync(legacyRoot, { recursive: true, force: true });
    }
  });

  it('preserves explicit project denied roots through settings and config save', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-denied-roots-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-denied-work-'));
    const deniedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-denied-explicit-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        `CTI_DEFAULT_WORKDIR=${workDir}`,
        `CTI_PROJECT_DENIED_ROOTS=${deniedRoot}`,
      ].join('\n'), 'utf8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?project-denied-roots-${Date.now()}`);
      const config = module.loadConfig();

      assert.deepEqual(config.projectDeniedRoots, [deniedRoot]);
      assert.equal(module.configToSettings(config).get('bridge_project_denied_roots'), deniedRoot);

      module.saveConfig(config);
      const saved = fs.readFileSync(path.join(configDir, 'config.env'), 'utf8');
      assert.match(saved, new RegExp(`^CTI_PROJECT_DENIED_ROOTS=${deniedRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(deniedRoot, { recursive: true, force: true });
    }
  });

  it('keeps upload cache outside the default work directory', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-upload-cache-config-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-upload-cache-work-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        `CTI_DEFAULT_WORKDIR=${workDir}`,
        `CTI_UPLOAD_CACHE_DIR=${path.join(workDir, '.codepilot-uploads')}`,
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?upload-cache-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.uploadCacheDir, path.join(configDir, 'runtime', 'uploads'));
      assert.equal(configToSettings(config).get('bridge_upload_cache_dir'), path.join(configDir, 'runtime', 'uploads'));
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('loads Feishu OAuth and cloud document env config', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-cloud-config-'));
    const previousCtiHome = process.env.CTI_HOME;
    try {
      fs.writeFileSync(path.join(configDir, 'config.env'), [
        'CTI_RUNTIME=codex',
        'CTI_DEFAULT_WORKDIR=C:\\unity\\ST3',
        'CTI_FEISHU_OAUTH_MODE=manual',
        'CTI_FEISHU_OAUTH_PUBLIC_BASE_URL=https://bot.example.com',
        'CTI_FEISHU_OAUTH_MANUAL_REDIRECT_URI=http://127.0.0.1:17321/feishu/oauth/callback',
        'CTI_FEISHU_GRANTED_SCOPES=im:message,docx:document:readonly',
        'CTI_FEISHU_OAUTH_CALLBACK_PATH=/feishu/oauth/callback',
        'CTI_FEISHU_OAUTH_SCOPES=offline_access,docx:document:readonly',
        'CTI_FEISHU_OAUTH_CALLBACK_PORT=17321',
        'CTI_FEISHU_CLOUD_MAX_CHARS=90000',
        'CTI_FEISHU_CLOUD_MAX_ROWS=600',
        'CTI_FEISHU_CLOUD_MAX_RECORDS=700',
        'CTI_FEISHU_CLOUD_MAX_SHEETS=6',
      ].join('\n'), 'utf-8');
      process.env.CTI_HOME = configDir;

      const module = await import(`../config.js?feishu-cloud-${Date.now()}`);
      const config = module.loadConfig();

      assert.equal(config.feishuOAuthPublicBaseUrl, 'https://bot.example.com');
      assert.equal(config.feishuOAuthMode, 'manual');
      assert.equal(config.feishuOAuthManualRedirectUri, 'http://127.0.0.1:17321/feishu/oauth/callback');
      assert.deepEqual(config.feishuGrantedScopes, ['im:message', 'docx:document:readonly']);
      assert.equal(config.feishuOAuthCallbackPath, '/feishu/oauth/callback');
      assert.deepEqual(config.feishuOAuthScopes, ['offline_access', 'docx:document:readonly']);
      assert.equal(config.feishuOAuthCallbackPort, 17321);
      assert.equal(config.feishuCloudMaxChars, 90000);
      assert.equal(config.feishuCloudMaxRows, 600);
      assert.equal(config.feishuCloudMaxRecords, 700);
      assert.equal(config.feishuCloudMaxSheets, 6);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
