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
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_domain'), 'example.com');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
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

  it('maps workspace roots, additional directories, and self-optimize flag', () => {
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
    assert.equal(
      m.get('bridge_default_additional_directories'),
      'E:\\cli-md;F:\\unity',
    );
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
});
