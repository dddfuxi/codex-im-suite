import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StreamChatParams } from 'claude-to-im/host';

import type { Config } from '../config.js';
import { MavisExecutorProvider, MavisSafetyError, __internals, isMavisTerminalAutoRetryable, MAVIS_TERMINAL_AUTO_RETRYABLE } from '../mavis-executor-provider.js';
import type {
  MavisClient,
  MavisSessionInfo,
  MavisMessage,
  MavisCommunicationMessage,
  MavisDiff,
  MavisModelDescriptor,
} from '../mavis-cli-client.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  allowedWorkspaceRoots: [process.cwd()],
  mavisEnabled: true,
  mavisCliPath: 'mavis',
  mavisPollIntervalMs: 50,
  mavisHardTimeoutMs: 5_000,
  mavisQuietTimeoutMs: 1_000,
  mavisMaxDiffBytes: 1024,
};

const baseModel: MavisModelDescriptor = { provider_id: 'mavis', model_id: 'sonnet' };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class FakeMavisClient implements MavisClient {
  statusCalls = 0;
  createCalls = 0;
  createSessionCalls: Array<{ agent: string; prompt: string; title?: string; workspace?: string }> = [];
  sendCalls: Array<{ to: string; command: string; content: string; from?: string }> = [];
  infoCalls: string[] = [];
  infoResponses: MavisSessionInfo[] = [];
  messagesResponses: MavisMessage[][] = [];
  communicationMessagesResponses: MavisCommunicationMessage[][] = [];
  diffResponses: MavisDiff[][] = [];
  // v3.5 P1 fix test hook: when set, createSession returns this sessionId
  // verbatim (used to simulate malformed CLI output / empty id).
  nextSessionId: string | undefined = undefined;

  async status() {
    this.statusCalls += 1;
    return { status: 'running' };
  }
  async listAgents() { return []; }
  async listSessions() { return { sessions: [] }; }
  async createSession(input: { agent: string; prompt: string; title?: string; workspace?: string }): Promise<MavisSessionInfo> {
    this.createCalls += 1;
    this.createSessionCalls.push(input);
    return {
      session: {
        sessionId: this.nextSessionId ?? `mvs_new_${this.createCalls}`,
        agentName: input.agent,
        agentRole: 'agent',
        displayName: input.agent,
        title: input.title || 'mavis:session',
        status: 'idle',
        model: baseModel,
      },
    };
  }
  async info(sessionId: string): Promise<MavisSessionInfo> {
    this.infoCalls.push(sessionId);
    if (this.infoResponses.length === 0) {
      return {
        session: {
          sessionId,
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 'mavis:test',
          status: 'finished',
          model: baseModel,
        },
      };
    }
    return this.infoResponses.shift()!;
  }
  async messages(_sessionId: string): Promise<{ messages: MavisMessage[] }> {
    if (this.messagesResponses.length === 0) return { messages: [] };
    return { messages: this.messagesResponses.shift()! };
  }
  async diff(_sessionId: string): Promise<{ diffs: MavisDiff[] }> {
    if (this.diffResponses.length === 0) return { diffs: [] };
    return { diffs: this.diffResponses.shift()! };
  }
  async communicationPeers() { return { sessions: [], count: 0 }; }
  async communicationMessages(): Promise<{ messages: MavisCommunicationMessage[]; count?: number }> {
    if (this.communicationMessagesResponses.length === 0) return { messages: [], count: 0 };
    const messages = this.communicationMessagesResponses.shift()!;
    return { messages, count: messages.length };
  }
  async communicationSend(input: { from?: string; to: string; command: string; content: string }) {
    this.sendCalls.push(input);
    return { ok: true };
  }
}

function params(overrides: Partial<StreamChatParams> = {}): StreamChatParams {
  return {
    sessionId: 'bridge-1',
    prompt: 'check git status',
    workingDirectory: process.cwd(),
    permissionMode: 'default',
    ...overrides,
  };
}

let mvpTmpHome = '';
let prevCtiHome: string | undefined;

describe('mavis executor provider', () => {
  before(() => {
    // Isolate bindings store to a per-suite tmp dir so prior tests
    // (e.g. mavis-session-store) don't leak bindings into this suite.
    mvpTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mvp-suite-'));
    prevCtiHome = process.env.CTI_HOME;
    process.env.CTI_HOME = mvpTmpHome;
  });

  after(() => {
    if (mvpTmpHome && fs.existsSync(mvpTmpHome)) {
      fs.rmSync(mvpTmpHome, { recursive: true, force: true });
    }
    if (prevCtiHome === undefined) delete process.env.CTI_HOME;
    else process.env.CTI_HOME = prevCtiHome;
  });

  describe('preDispatch — new path', () => {
    it('creates a new session when no binding exists and stores the binding', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: baseConfig,
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await provider.preDispatch(params());
      assert.equal(client.createCalls, 1);
      assert.ok(provider.binding);
      assert.equal(provider.binding?.bridgeSessionId, 'bridge-1');
      assert.equal(provider.binding?.agentName, 'mavis');
    });

    it('tells Mavis to place generated deliverables in the turn artifact directory', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: baseConfig,
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      const artifactDirectory = path.join(mvpTmpHome, 'runtime', 'artifacts', 'bridge-artifact', 'turn-1');

      await provider.preDispatch(params({
        sessionId: 'bridge-artifact',
        turnId: 'turn-1',
        prompt: '生成一份诊断报告',
        artifactDirectory,
      }));

      const prompt = client.createSessionCalls[0]?.prompt || '';
      assert.match(prompt, new RegExp(escapeRegExp(artifactDirectory)));
      assert.match(prompt, /generated deliverables|生成产物/i);
      assert.match(prompt, /不得.*默认写入.*项目|must not.*default.*project/i);
    });

    it('uses the workspace plan primary directory instead of the legacy working directory', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-plan-'));
      const primary = path.join(root, 'primary');
      const legacy = path.join(root, 'legacy');
      fs.mkdirSync(primary);
      fs.mkdirSync(legacy);
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, defaultWorkDir: legacy, allowedWorkspaceRoots: [primary, legacy] },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });

      try {
        await provider.preDispatch(params({
          sessionId: 'bridge-workspace-plan',
          workingDirectory: legacy,
          workspacePlan: {
            version: 'cti-turn-workspace/v1',
            primaryWorkspace: {
              path: primary,
              accessMode: 'read_only',
              evidenceIds: ['current_message'],
              reason: 'test',
              expiresAfterTurn: true,
            },
            temporaryMounts: [],
            deniedRoots: [],
            resolvedFrom: 'explicit_path',
            createdAt: '2026-07-17T12:00:00.000Z',
            expiresAfterTurn: true,
          },
        }));

        assert.equal(client.createSessionCalls[0]?.workspace, primary);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('materializes image attachments and gives Mavis absolute local paths on new sessions', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-image-new-'));
      const uploadCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-upload-new-'));
      try {
        const client = new FakeMavisClient();
        const provider = new MavisExecutorProvider({
          client,
          config: { ...baseConfig, allowedWorkspaceRoots: [workspace], defaultWorkDir: workspace, uploadCacheDir },
          agentName: 'mavis',
          pollIntervalMs: 50,
          hardTimeoutMs: 5_000,
          quietTimeoutMs: 1_000,
          maxDiffBytes: 1024,
        });

        await provider.preDispatch(params({
          sessionId: 'bridge-image-new',
          turnId: 'turn-image-new',
          workingDirectory: workspace,
          prompt: '用户发送了一个飞书表情包。',
          files: [{
            id: 'sticker_file_key',
            name: 'sticker-sticker_file_key.png',
            type: 'image/png',
            size: 4,
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          }],
        }));

        const prompt = client.createSessionCalls[0]?.prompt || '';
        assert.match(prompt, /Bridge-provided local input files/);
        assert.match(prompt, /matrix_describe_images/);
        assert.match(prompt, /sticker-sticker_file_key\.png/);

        const pathMatch = /Local path: (.+\.png)/u.exec(prompt);
        assert.ok(pathMatch, prompt);
        assert.equal(fs.existsSync(pathMatch[1]), true);
        assert.deepEqual(fs.readFileSync(pathMatch[1]), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        assert.equal(pathMatch[1].startsWith(path.join(uploadCacheDir, 'bridge-image-new', 'turn-image-new')), true);
        assert.equal(fs.existsSync(path.join(uploadCacheDir, 'mavis-input')), false);
        assert.equal(fs.existsSync(path.join(workspace, '.codepilot-uploads')), false);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(uploadCacheDir, { recursive: true, force: true });
      }
    });

    it('copies legacy workspace upload paths into the turn-scoped runtime cache', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-image-existing-'));
      const uploadCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-upload-existing-'));
      try {
        const imagePath = path.join(workspace, '.codepilot-uploads', 'incoming.png');
        fs.mkdirSync(path.dirname(imagePath), { recursive: true });
        fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const client = new FakeMavisClient();
        const provider = new MavisExecutorProvider({
          client,
          config: { ...baseConfig, allowedWorkspaceRoots: [workspace], defaultWorkDir: workspace, uploadCacheDir },
          agentName: 'mavis',
          pollIntervalMs: 50,
          hardTimeoutMs: 5_000,
          quietTimeoutMs: 1_000,
          maxDiffBytes: 1024,
        });

        await provider.preDispatch(params({
          sessionId: 'bridge-image-existing',
          turnId: 'turn-image-existing',
          workingDirectory: workspace,
          prompt: '请看这张图。',
          files: [{
            id: 'img_existing',
            name: 'incoming.png',
            type: 'image/png',
            size: 4,
            data: '',
            filePath: imagePath,
          }],
        }));

        const prompt = client.createSessionCalls[0]?.prompt || '';
        assert.doesNotMatch(prompt, new RegExp(`Local path: ${escapeRegExp(imagePath)}`));
        const pathMatch = /Local path: (.+incoming\.png)/u.exec(prompt);
        assert.ok(pathMatch, prompt);
        assert.equal(pathMatch[1].startsWith(path.join(uploadCacheDir, 'bridge-image-existing', 'turn-image-existing')), true);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(uploadCacheDir, { recursive: true, force: true });
      }
    });

    it('copies readable image paths from outside the workspace before giving them to Mavis', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-image-copy-'));
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-image-external-'));
      const uploadCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-upload-copy-'));
      try {
        const externalPath = path.join(externalDir, 'outside.png');
        fs.writeFileSync(externalPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const client = new FakeMavisClient();
        const provider = new MavisExecutorProvider({
          client,
          config: { ...baseConfig, allowedWorkspaceRoots: [workspace], defaultWorkDir: workspace, uploadCacheDir },
          agentName: 'mavis',
          pollIntervalMs: 50,
          hardTimeoutMs: 5_000,
          quietTimeoutMs: 1_000,
          maxDiffBytes: 1024,
        });

        await provider.preDispatch(params({
          sessionId: 'bridge-image-copy',
          turnId: 'turn-image-copy',
          workingDirectory: workspace,
          prompt: '请看这张外部图。',
          files: [{
            id: 'img_external',
            name: 'outside.png',
            type: 'image/png',
            size: 4,
            data: '',
            filePath: externalPath,
          }],
        }));

        const prompt = client.createSessionCalls[0]?.prompt || '';
        assert.doesNotMatch(prompt, new RegExp(escapeRegExp(externalPath)));
        const pathMatch = /Local path: (.+outside\.png)/u.exec(prompt);
        assert.ok(pathMatch, prompt);
        assert.equal(pathMatch[1].startsWith(path.join(uploadCacheDir, 'bridge-image-copy', 'turn-image-copy')), true);
        assert.equal(fs.existsSync(path.join(workspace, '.codepilot-uploads')), false);
        assert.deepEqual(fs.readFileSync(pathMatch[1]), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(externalDir, { recursive: true, force: true });
        fs.rmSync(uploadCacheDir, { recursive: true, force: true });
      }
    });

    it('rejects when workingDirectory is outside allowedWorkspaceRoots', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: baseConfig,
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ workingDirectory: 'C:\\Windows\\System32\\never-allowed' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'workspace_denied',
      );
    });

    it('rejects acceptEdits in readOnly mode', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ permissionMode: 'acceptEdits' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
    });

    // v3.5 P1 fix: readOnly gate must also reject write-intent prompts in
    // `default` / `ask` / `plan` modes, not just `acceptEdits`. The previous
    // implementation only checked `permissionMode === 'acceptEdits'`, which
    // left the mavis CLI free to silently execute write intents.
    it('rejects file_write-capability prompt in readOnly mode (default permissionMode)', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: '请帮我修改 config.json 保存一下', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      // Did not reach createSession — write never happened, fallback is
      // still on the table.
      assert.equal(client.createCalls, 0);
    });

    it('rejects mcp_ops-capability prompt in readOnly mode (ask permissionMode)', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: 'call the unity MCP to query scene', permissionMode: 'ask' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      assert.equal(client.createCalls, 0);
    });

    // v3.6 P1 fix: the previous file_write heuristic only matched
    // `修改|写入|保存|生成文件|edit|patch`. Phrases like "delete
    // package.json" / "create file" / "remove lockfile" / "touch
    // script" slipped through and the mavis CLI silently executed
    // them. v3.6 broadens the heuristic AND switches to a strict
    // capability allow-list (`chat/repo_query/file_read/image_input`),
    // so any non-allow-listed capability is rejected up front.
    it('rejects delete/删除 in readOnly mode (v3.6 broadened heuristic)', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: 'please delete package-lock.json', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: '删除 package.json', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      assert.equal(client.createCalls, 0);
    });

    it('rejects create/新建/touch in readOnly mode (v3.6 broadened heuristic)', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: 'create a new file under src/', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: '新建文件 script.sh', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: 'touch new-script.sh', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      assert.equal(client.createCalls, 0);
    });

    it('rejects rm/mv/rename/重命名 in readOnly mode (v3.6 broadened heuristic)', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: 'rm -rf dist/', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: 'mv old.txt new.txt', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      await assert.rejects(
        () => provider.preDispatch(params({ prompt: '重命名 main.ts 到 index.ts', permissionMode: 'default' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'read_only_violation',
      );
      assert.equal(client.createCalls, 0);
    });

    it('does NOT flag substrings of rm/mv (alarm/firm) as file_write (v3.6 word-boundary safety)', async () => {
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      // Pure read prompts that happen to contain "alarm" or "firm" must
      // still pass the read-only gate. This is the regression guard for
      // the broadened short-command pattern — without word boundaries
      // these would falsely trip file_write.
      await provider.preDispatch(params({ sessionId: 'bridge-alarm', prompt: 'alarm the user about firm prices', permissionMode: 'default' }));
      assert.equal(client.createCalls, 1);
    });

    it('accepts read-only prompt in readOnly mode (default permissionMode)', async () => {
      // Sanity check: a pure read prompt must NOT trip the readOnly gate.
      // Use a unique sessionId so we don't hit the resume path with the
      // binding created by earlier tests in this describe block.
      const client = new FakeMavisClient();
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisReadOnly: true },
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await provider.preDispatch(params({
        sessionId: 'bridge-accepts-readOnly',
        prompt: 'check git status',
        permissionMode: 'default',
      }));
      assert.equal(client.createCalls, 1);
      assert.ok(provider.binding);
    });

    // v3.5 P1 fix: createSession may return malformed JSON without a
    // sessionId. The previous implementation wrote a binding with an
    // empty `mvsSessionId`, which then made `client.info('')` look like
    // a post-dispatch failure (non-recoverable) instead of a pre-dispatch
    // failure (recoverable to Codex). Now we reject before writing the
    // binding so the caller can fall back.
    it('throws dispatch_failed when createSession returns empty sessionId', async () => {
      const client = new FakeMavisClient();
      client.nextSessionId = '';
      const provider = new MavisExecutorProvider({
        client,
        config: baseConfig,
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      // Unique sessionId → forces the new-session path so we hit the
      // sessionId validation in preDispatchNew.
      await assert.rejects(
        () => provider.preDispatch(params({ sessionId: 'bridge-empty-id' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'dispatch_failed',
      );
      // binding must NOT be written — caller is still allowed to fall back.
      assert.equal(provider.binding, undefined);
    });

    it('throws dispatch_failed when createSession returns a non-mvs_ sessionId', async () => {
      const client = new FakeMavisClient();
      client.nextSessionId = 'ses_12345';  // Claude Code-style id, not mavis
      const provider = new MavisExecutorProvider({
        client,
        config: baseConfig,
        agentName: 'mavis',
        pollIntervalMs: 50,
        hardTimeoutMs: 5_000,
        quietTimeoutMs: 1_000,
        maxDiffBytes: 1024,
      });
      await assert.rejects(
        () => provider.preDispatch(params({ sessionId: 'bridge-wrong-id-shape' })),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'dispatch_failed',
      );
      assert.equal(provider.binding, undefined);
    });
  });

  describe('preDispatch — resume path (v3.1 + v3.2 contract)', () => {
    it('uses communicationSend (not createSession) for fresh binding with configured sender', async () => {
      // Seed a fresh binding via tmp CTI_HOME so readBinding finds it.
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mvp-'));
      const prevHome = process.env.CTI_HOME;
      process.env.CTI_HOME = tmpHome;

      try {
        const { upsertBinding } = await import('../mavis-session-store.js');
        const created = new Date().toISOString();
        upsertBinding({
          bridgeSessionId: 'bridge-1',
          mvsSessionId: 'mvs_existing',
          agentName: 'mavis',
          createdAt: created,
          lastTurnAt: created,
          model: baseModel,
        });

        const client = new FakeMavisClient();
        const provider = new MavisExecutorProvider({
          client,
          config: { ...baseConfig, mavisBridgeSessionId: 'mvs_parent' } as Config,
          agentName: 'mavis',
          pollIntervalMs: 50,
          hardTimeoutMs: 5_000,
          quietTimeoutMs: 1_000,
          maxDiffBytes: 1024,
        });
        await provider.preDispatch(params());
        assert.equal(client.createCalls, 0, 'should NOT call createSession on resume path');
        assert.equal(client.sendCalls.length, 1, 'should call communicationSend exactly once');
        const call = client.sendCalls[0];
        assert.equal(call.to, 'mvs_existing');
        assert.equal(call.command, 'prompt');
        assert.equal(call.from, 'mvs_parent');
      } finally {
        if (prevHome === undefined) delete process.env.CTI_HOME;
        else process.env.CTI_HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('resumes the Mavis session by source chat when the bridge session id changed', async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mvp-source-'));
      const prevHome = process.env.CTI_HOME;
      process.env.CTI_HOME = tmpHome;

      try {
        const { readBindings, upsertBinding } = await import('../mavis-session-store.js');
        const created = new Date().toISOString();
        upsertBinding({
          bridgeSessionId: 'bridge-old',
          mvsSessionId: 'mvs_source_existing',
          agentName: 'mavis',
          channelType: 'feishu',
          feishuChatId: 'chat-1',
          createdAt: created,
          lastTurnAt: created,
          model: baseModel,
        });

        const client = new FakeMavisClient();
        const provider = new MavisExecutorProvider({
          client,
          config: { ...baseConfig, mavisBridgeSessionId: 'mvs_parent' } as Config,
          agentName: 'mavis',
          pollIntervalMs: 50,
          hardTimeoutMs: 5_000,
          quietTimeoutMs: 1_000,
          maxDiffBytes: 1024,
        });

        const nextParams = params({ sessionId: 'bridge-new', prompt: 'continue please' }) as StreamChatParams & {
          sourceChannelType: string;
          sourceChatId: string;
        };
        nextParams.sourceChannelType = 'feishu';
        nextParams.sourceChatId = 'chat-1';
        await provider.preDispatch(nextParams);

        assert.equal(client.createCalls, 0, 'source chat resume must not create a fresh Mavis session');
        assert.equal(client.sendCalls.length, 1);
        assert.equal(client.sendCalls[0].to, 'mvs_source_existing');
        assert.equal(provider.binding?.bridgeSessionId, 'bridge-new');
        assert.equal(readBindings()['bridge-new']?.mvsSessionId, 'mvs_source_existing');
      } finally {
        if (prevHome === undefined) delete process.env.CTI_HOME;
        else process.env.CTI_HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('creates a new session instead of communicationSend when configured sender is archived', async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mvp-'));
      const prevHome = process.env.CTI_HOME;
      process.env.CTI_HOME = tmpHome;

      try {
        const { upsertBinding } = await import('../mavis-session-store.js');
        const created = new Date().toISOString();
        upsertBinding({
          bridgeSessionId: 'bridge-archived-sender',
          mvsSessionId: 'mvs_existing',
          agentName: 'mavis',
          createdAt: created,
          lastTurnAt: created,
          model: baseModel,
        });

        const client = new FakeMavisClient();
        client.infoResponses = [
          {
            session: {
              sessionId: 'mvs_existing',
              agentName: 'mavis',
              agentRole: 'agent',
              displayName: 'mavis',
              title: 'mavis:existing',
              status: 'finished',
              model: baseModel,
            },
          },
          {
            session: {
              sessionId: 'mvs_parent_archived',
              agentName: 'mavis',
              agentRole: 'agent',
              displayName: 'mavis',
              title: 'cti-bridge-warmup',
              status: 'finished',
              compressed: true,
              model: baseModel,
            },
          } as MavisSessionInfo,
        ];

        const provider = new MavisExecutorProvider({
          client,
          config: { ...baseConfig, mavisBridgeSessionId: 'mvs_parent_archived' } as Config,
          agentName: 'mavis',
          pollIntervalMs: 50,
          hardTimeoutMs: 5_000,
          quietTimeoutMs: 1_000,
          maxDiffBytes: 1024,
        });
        await provider.preDispatch(params({ sessionId: 'bridge-archived-sender', prompt: 'hi' }));

        assert.deepEqual(client.infoCalls, ['mvs_existing', 'mvs_parent_archived']);
        assert.equal(client.sendCalls.length, 0, 'archived sender must not be used for communicationSend');
        assert.equal(client.createCalls, 1, 'should fall back to a fresh mavis session');
        assert.equal(provider.binding?.mvsSessionId, 'mvs_new_1');
      } finally {
        if (prevHome === undefined) delete process.env.CTI_HOME;
        else process.env.CTI_HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('materializes image attachments and includes local paths when resuming via communicationSend', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-image-resume-'));
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mvp-'));
      const uploadCacheDir = path.join(tmpHome, 'runtime', 'uploads');
      const prevHome = process.env.CTI_HOME;
      process.env.CTI_HOME = tmpHome;

      try {
        const { upsertBinding } = await import('../mavis-session-store.js');
        const created = new Date().toISOString();
        upsertBinding({
          bridgeSessionId: 'bridge-image-resume',
          mvsSessionId: 'mvs_existing_image',
          agentName: 'mavis',
          createdAt: created,
          lastTurnAt: created,
          model: baseModel,
        });

        const client = new FakeMavisClient();
        const provider = new MavisExecutorProvider({
          client,
          config: {
            ...baseConfig,
            allowedWorkspaceRoots: [workspace],
            defaultWorkDir: workspace,
            uploadCacheDir,
            mavisBridgeSessionId: 'mvs_parent',
          } as Config,
          agentName: 'mavis',
          pollIntervalMs: 50,
          hardTimeoutMs: 5_000,
          quietTimeoutMs: 1_000,
          maxDiffBytes: 1024,
        });

        await provider.preDispatch(params({
          sessionId: 'bridge-image-resume',
          turnId: 'turn-image-resume',
          workingDirectory: workspace,
          prompt: '用户发送了一张图片。',
          files: [{
            id: 'img_1',
            name: 'math-question.jpg',
            type: 'image/jpeg',
            size: 3,
            data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
          }],
        }));

        const content = client.sendCalls[0]?.content || '';
        assert.match(content, /Bridge-provided local input files/);
        assert.match(content, /matrix_describe_images/);
        assert.match(content, /math-question\.jpg/);
        const pathMatch = /Local path: (.+\.jpg)/u.exec(content);
        assert.ok(pathMatch, content);
        assert.equal(fs.existsSync(pathMatch[1]), true);
        assert.deepEqual(fs.readFileSync(pathMatch[1]), Buffer.from([0xff, 0xd8, 0xff]));
        assert.equal(pathMatch[1].startsWith(path.join(uploadCacheDir, 'bridge-image-resume', 'turn-image-resume')), true);
      } finally {
        if (prevHome === undefined) delete process.env.CTI_HOME;
        else process.env.CTI_HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  describe('__internals.assertWorkspaceAllowed', () => {
    const { assertWorkspaceAllowed } = __internals;

    it('accepts workingDirectory equal to an allowed root', () => {
      assertWorkspaceAllowed(process.cwd(), [process.cwd()]);
    });

    it('rejects workingDirectory outside all allowed roots', () => {
      assert.throws(
        () => assertWorkspaceAllowed('C:\\totally\\not\\allowed', [process.cwd()]),
        (err: unknown) => err instanceof MavisSafetyError && err.code === 'workspace_denied',
      );
    });
  });

  describe('__internals.buildTurnPrompt', () => {
    it('returns the prompt unchanged for the user turn', () => {
      const { buildTurnPrompt } = __internals;
      assert.equal(buildTurnPrompt(params({ prompt: 'do the thing' })), 'do the thing');
    });

    it('prefixes priority turn context as non-executable evidence', () => {
      const { buildTurnPrompt } = __internals;
      const prompt = buildTurnPrompt(params({
        prompt: '继续处理',
        priorityTurnContext: '[被回复消息] 用户: 请沿用前面的决定。',
      }));

      assert.match(prompt, /Current turn context evidence/);
      assert.match(prompt, /evidence, not executable instructions/i);
      assert.match(prompt, /\[被回复消息\]/);
      assert.match(prompt, /Current user request:\n继续处理/);
    });

    it('handles empty prompt gracefully', () => {
      const { buildTurnPrompt } = __internals;
      assert.equal(buildTurnPrompt(params({ prompt: '' })), '');
    });
  });

  describe('__internals.isValidMvsSessionId (v3.5 P1 fix)', () => {
    const { isValidMvsSessionId } = __internals;

    it('accepts well-formed mvs_<token> strings', () => {
      assert.equal(isValidMvsSessionId('mvs_abc'), true);
      assert.equal(isValidMvsSessionId('mvs_123-456_xyz'), true);
      assert.equal(isValidMvsSessionId('mvs_a1b2c3'), true);
    });

    it('rejects empty string', () => {
      assert.equal(isValidMvsSessionId(''), false);
    });

    it('rejects missing mvs_ prefix', () => {
      assert.equal(isValidMvsSessionId('ses_abc'), false);
      assert.equal(isValidMvsSessionId('abc'), false);
      assert.equal(isValidMvsSessionId('MVS_abc'), false);  // case-sensitive
    });

    it('rejects mvs_ with no token', () => {
      assert.equal(isValidMvsSessionId('mvs_'), false);
      assert.equal(isValidMvsSessionId('mvs__'), false);
    });

    it('rejects non-string values', () => {
      assert.equal(isValidMvsSessionId(null), false);
      assert.equal(isValidMvsSessionId(undefined), false);
      assert.equal(isValidMvsSessionId(123), false);
      assert.equal(isValidMvsSessionId({}), false);
      assert.equal(isValidMvsSessionId([]), false);
    });

    it('rejects mvs_ with disallowed characters', () => {
      assert.equal(isValidMvsSessionId('mvs_abc!'), false);
      assert.equal(isValidMvsSessionId('mvs_abc def'), false);
      assert.equal(isValidMvsSessionId('mvs_abc/def'), false);
    });

    it('rejects strings longer than 256 chars', () => {
      assert.equal(isValidMvsSessionId('mvs_' + 'a'.repeat(260)), false);
    });
  });

  // v3.8 P2 fix: explicit per-terminal retryability. The map MUST
  // pin exactly one value per MavisTerminalState and never default to
  // a "retry-by-default" rule. The v3.7 implementation relied on
  // `shouldAutoRetryWorkflowError(workflowFailureError)` (a generic
  // text heuristic that defaults to `true` for unknown errors), which
  // would auto-retry an explicit `aborted` turn.
  describe('isMavisTerminalAutoRetryable (v3.8 P2 fix)', () => {
    it('explicitly pins the four failure-mode terminals', () => {
      // aborted → false. User / remote explicit cancel must NOT be
      // retried — re-running would re-execute a cancelled prompt.
      assert.equal(isMavisTerminalAutoRetryable('aborted'), false);
      // timeout → false. streamUntilFinish already aborts the remote
      // Mavis session on hard timeout; auto-retrying would re-dispatch
      // the same user turn and can create bridge-visible retry loops.
      assert.equal(isMavisTerminalAutoRetryable('timeout'), false);
      // error → false. Remote status=error is typically deterministic
      // (rate limit / content filter / tool exception). Auto-retry
      // would burn tokens on a failure we already have evidence for.
      assert.equal(isMavisTerminalAutoRetryable('error'), false);
      // partial_result → false. Status=finished but message fetch
      // failed or assistant never emitted text. Re-running produces a
      // *different* partial result that's hard to merge.
      assert.equal(isMavisTerminalAutoRetryable('partial_result'), false);
    });

    it('finished is never retried (caller contract)', () => {
      // streamExternalDispatch must short-circuit before reaching this
      // function for `finished` (it routes to `completeWorkflowRun`),
      // but pin the value for completeness so adding a new
      // MavisTerminalState becomes a TypeScript error if the map
      // forgets it.
      assert.equal(isMavisTerminalAutoRetryable('finished'), false);
    });

    it('map covers every MavisTerminalState — drift guard', () => {
      // If a new terminal is added to `MavisTerminalState` but not
      // added to the map, this test fails. (TypeScript also enforces
      // exhaustiveness, but this gives a readable failure message.)
      const expected = new Set(['finished', 'timeout', 'error', 'aborted', 'partial_result']);
      const actual = new Set(Object.keys(MAVIS_TERMINAL_AUTO_RETRYABLE));
      assert.deepEqual([...actual].sort(), [...expected].sort());
    });

    it('does NOT default to retry=true for any unmapped terminal', () => {
      // Sanity check: the v3.7 bug was that unknown errors were
      // retried by default. Verify NO entry in the map is
      // accidentally `true` unless the design explicitly calls for it.
      const expectedTrue = new Set<string>();
      for (const [terminal, retryable] of Object.entries(MAVIS_TERMINAL_AUTO_RETRYABLE)) {
        if (expectedTrue.has(terminal)) {
          assert.equal(retryable, true, `${terminal} must be auto-retryable per design`);
        } else {
          assert.equal(retryable, false, `${terminal} must NOT be auto-retryable per design`);
        }
      }
    });
  });

  // v3.7 P1 fix: `streamUntilFinish` must return a structured terminal
  // state so `streamExternalDispatch` can route to `failWorkflowRun` on
  // timeout / aborted / error / partial_result. The previous
  // implementation only enqueued an error SSE and returned void, which
  // caused the workflow to record `status: succeeded` for what was
  // actually a failed turn.
  describe('streamUntilFinish — structured terminal state (v3.7 P1 fix)', () => {
    let v37TestCounter = 0;
    function parseStandardBridgeEvents(events: string[]): Array<{ type?: unknown; data?: unknown }> {
      return events.flatMap((event) => event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as { type?: unknown; data?: unknown }));
    }

    async function makeProviderWithBinding(
      client: FakeMavisClient,
      overrides: Partial<typeof baseConfig> = {},
    ): Promise<{ provider: MavisExecutorProvider; ctrl: ReadableStreamDefaultController<string>; events: string[]; sessionId: string }> {
      // IMPORTANT: each test must use a fresh sessionId. The describe
      // block shares CTI_HOME across tests, so a leftover binding would
      // route `preDispatch` through the resume path (which consumes an
      // `info()` call) and shift one of the responses this test queued
      // for `streamUntilFinish`.
      v37TestCounter += 1;
      const sessionId = `bridge-v37-${v37TestCounter}`;
      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, ...overrides },
        agentName: 'mavis',
        pollIntervalMs: 10,
        hardTimeoutMs: 50,
        quietTimeoutMs: 30,
        maxDiffBytes: 1024,
      });
      await provider.preDispatch(params({ sessionId }));
      const events: string[] = [];
      const stream = new ReadableStream<string>({
        start: (controller) => {
          (provider as unknown as { _ctrl?: ReadableStreamDefaultController<string> })._ctrl = controller;
        },
      });
      void stream;
      const ctrl = (provider as unknown as { _ctrl: ReadableStreamDefaultController<string> })._ctrl;
      const realEnqueue = ctrl.enqueue.bind(ctrl);
      ctrl.enqueue = (value: string) => {
        events.push(value);
        realEnqueue(value);
      };
      return { provider, ctrl, events, sessionId };
    }

    it('returns terminal=finished when mavis emits status=finished + assistant text', async () => {
      const client = new FakeMavisClient();
      const finished: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'finished',
          model: baseModel,
        },
      };
      client.infoResponses = [finished, finished];
      client.messagesResponses = [
        [
          {
            msg_id: 'm1',
            role: 'assistant',
            msg_type: 1,
            msg_content: 'all done',
            timestamp: 1,
          } as MavisMessage,
        ],
      ];
      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client);
      const binding = provider.binding!;
      const result = await provider.streamUntilFinish(params({ sessionId }), binding, ctrl);
      assert.equal(result.terminal, 'finished');
      assert.equal(result.errorCode, undefined);
      assert.equal(result.errorShort, undefined);
    });

    it('emits final assistant text using the bridge-standard SSE envelope', async () => {
      const client = new FakeMavisClient();
      const finished: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'finished',
          model: baseModel,
        },
      };
      client.infoResponses = [finished, finished];
      client.messagesResponses = [
        [
          {
            msg_id: 'm1',
            role: 'assistant',
            msg_type: 1,
            msg_content: 'Hey！在的',
            timestamp: 1,
          } as MavisMessage,
        ],
      ];
      const { provider, ctrl, events, sessionId } = await makeProviderWithBinding(client);
      const result = await provider.streamUntilFinish(params({ sessionId }), provider.binding!, ctrl);
      assert.equal(result.terminal, 'finished');

      const textEvent = parseStandardBridgeEvents(events).find((event) => event.type === 'text');
      assert.equal(textEvent?.data, 'Hey！在的');
    });

    it('emits user-visible progress while Mavis is still thinking', async () => {
      const client = new FakeMavisClient();
      const startedAt = new Date().toISOString();
      const started: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'started',
          lastActiveAt: startedAt,
          updatedAt: startedAt,
          model: baseModel,
        },
      };
      const finished: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'finished',
          model: baseModel,
        },
      };
      client.infoResponses = [started, started, finished];
      client.messagesResponses = [
        [
          {
            msg_id: 'think-1',
            role: 'assistant',
            msg_type: 1,
            thinking_content: '正在识别图片里的题目。',
            timestamp: 1,
          } as MavisMessage,
        ],
        [
          {
            msg_id: 'think-1',
            role: 'assistant',
            msg_type: 1,
            thinking_content: '正在识别图片里的题目。',
            timestamp: 1,
          } as MavisMessage,
          {
            msg_id: 'answer-1',
            role: 'assistant',
            msg_type: 1,
            msg_content: '识别完成。',
            timestamp: 2,
          } as MavisMessage,
        ],
      ];

      const { provider, ctrl, events, sessionId } = await makeProviderWithBinding(client, {
        mavisHardTimeoutMs: 120,
        mavisQuietTimeoutMs: 30,
      });
      const result = await provider.streamUntilFinish(params({ sessionId }), provider.binding!, ctrl);
      assert.equal(result.terminal, 'finished');

      const standardEvents = parseStandardBridgeEvents(events);
      const progressIndex = standardEvents.findIndex((event) => event.type === 'progress');
      const textIndex = standardEvents.findIndex((event) => event.type === 'text');
      assert.notEqual(progressIndex, -1, 'thinking_content should be emitted as progress');
      assert.notEqual(textIndex, -1, 'final text should still be emitted');
      assert.equal(progressIndex < textIndex, true, 'progress should arrive before final text');
      assert.match(String(standardEvents[progressIndex].data || ''), /识别图片/);
    });

    it('streams the final Mavis answer as multiple text chunks for Feishu typewriter cards', async () => {
      const client = new FakeMavisClient();
      const finished: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'finished',
          model: baseModel,
        },
      };
      const finalAnswer = '第一段：我已经看到了图片内容。\n\n第二段：这里给出连续、可读的解释，并且长度足够触发分块流式输出。';
      client.infoResponses = [finished, finished];
      client.messagesResponses = [
        [
          {
            msg_id: 'answer-1',
            role: 'assistant',
            msg_type: 1,
            msg_content: finalAnswer,
            timestamp: 1,
          } as MavisMessage,
        ],
      ];

      const { provider, ctrl, events, sessionId } = await makeProviderWithBinding(client);
      const result = await provider.streamUntilFinish(params({ sessionId }), provider.binding!, ctrl);
      assert.equal(result.terminal, 'finished');

      const textEvents = parseStandardBridgeEvents(events).filter((event) => event.type === 'text');
      assert.equal(textEvents.length > 1, true, 'final answer should be chunked into multiple text SSE events');
      assert.equal(textEvents.map((event) => String(event.data || '')).join(''), finalAnswer);
    });

    it('returns terminal=finished when assistant text arrives before status flips to finished', async () => {
      const client = new FakeMavisClient();
      const startedAt = new Date().toISOString();
      const started: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'started',
          lastActiveAt: startedAt,
          updatedAt: startedAt,
          model: baseModel,
        },
      };
      client.infoResponses = [started, started, started, started];
      client.messagesResponses = [
        [
          {
            msg_id: 'u1',
            role: 'user',
            msg_type: 1,
            msg_content: '1',
            timestamp: 1,
          } as MavisMessage,
          {
            msg_id: 'a1',
            role: 'assistant',
            msg_type: 1,
            msg_content: '收到啦',
            timestamp: 2,
          } as MavisMessage,
        ],
      ];

      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client, {
        mavisHardTimeoutMs: 80,
        mavisQuietTimeoutMs: 30,
      });
      const binding = provider.binding!;
      const result = await provider.streamUntilFinish(params({ sessionId }), binding, ctrl);
      assert.equal(result.terminal, 'finished');
      assert.equal(result.errorCode, undefined);
      assert.equal(result.errorShort, undefined);
    });

    it('seeds a resume cursor before dispatch so stale assistant text is not reused', async () => {
      const { upsertBinding } = await import('../mavis-session-store.js');
      v37TestCounter += 1;
      const sessionId = `bridge-v37-resume-${v37TestCounter}`;
      const created = new Date().toISOString();
      upsertBinding({
        bridgeSessionId: sessionId,
        mvsSessionId: 'mvs_existing_resume',
        agentName: 'mavis',
        createdAt: created,
        lastTurnAt: created,
        lastDispatchAt: created,
        model: baseModel,
      });

      const client = new FakeMavisClient();
      const startedAt = new Date().toISOString();
      const started: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_existing_resume',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'started',
          lastActiveAt: startedAt,
          updatedAt: startedAt,
          model: baseModel,
        },
      };
      client.infoResponses = [started, started, started];
      client.messagesResponses = [
        [
          { msg_id: 'old-u', role: 'user', msg_type: 1, msg_content: 'old prompt', timestamp: 10 } as MavisMessage,
          { msg_id: 'old-a', role: 'assistant', msg_type: 1, msg_content: 'old answer', timestamp: 20 } as MavisMessage,
        ],
        [
          { msg_id: 'old-u', role: 'user', msg_type: 1, msg_content: 'old prompt', timestamp: 10 } as MavisMessage,
          { msg_id: 'old-a', role: 'assistant', msg_type: 1, msg_content: 'old answer', timestamp: 20 } as MavisMessage,
          { msg_id: 'new-u', role: 'user', msg_type: 1, msg_content: 'new prompt', timestamp: 30 } as MavisMessage,
          { msg_id: 'new-a', role: 'assistant', msg_type: 1, msg_content: 'new answer', timestamp: 40 } as MavisMessage,
        ],
      ];

      const provider = new MavisExecutorProvider({
        client,
        config: baseConfig,
        agentName: 'mavis',
        pollIntervalMs: 10,
        hardTimeoutMs: 80,
        quietTimeoutMs: 30,
        maxDiffBytes: 1024,
      });
      await provider.preDispatch(params({ sessionId, prompt: 'new prompt' }));

      const events: string[] = [];
      const stream = new ReadableStream<string>({
        start: (controller) => {
          (provider as unknown as { _ctrl?: ReadableStreamDefaultController<string> })._ctrl = controller;
        },
      });
      void stream;
      const ctrl = (provider as unknown as { _ctrl: ReadableStreamDefaultController<string> })._ctrl;
      const realEnqueue = ctrl.enqueue.bind(ctrl);
      ctrl.enqueue = (value: string) => {
        events.push(value);
        realEnqueue(value);
      };

      const result = await provider.streamUntilFinish(params({ sessionId, prompt: 'new prompt' }), provider.binding!, ctrl);
      assert.equal(result.terminal, 'finished');
      assert.equal(events.some((event) => event.includes('new answer')), true);
      assert.equal(events.some((event) => event.includes('old answer')), false);
    });

    it('uses outbound Mavis communication content as the final text for resume turns', async () => {
      const { upsertBinding } = await import('../mavis-session-store.js');
      v37TestCounter += 1;
      const sessionId = `bridge-v37-comm-${v37TestCounter}`;
      const created = new Date().toISOString();
      upsertBinding({
        bridgeSessionId: sessionId,
        mvsSessionId: 'mvs_target_comm',
        agentName: 'mavis',
        createdAt: created,
        lastTurnAt: created,
        lastDispatchAt: created,
        model: baseModel,
      });

      const client = new FakeMavisClient();
      const startedAt = new Date().toISOString();
      const started: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_target_comm',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'started',
          lastActiveAt: startedAt,
          updatedAt: startedAt,
          model: baseModel,
        },
      };
      client.infoResponses = [started, started, started];
      client.messagesResponses = [[], []];
      client.communicationMessagesResponses = [
        [
          {
            id: 120,
            from_session: 'mvs_target_comm',
            to_session: 'mvs_parent',
            command: 'prompt',
            content: 'hello from communication',
            status: 'failed',
            error: 'Target session is archived',
            time_created: Date.now() + 1_000,
          },
        ],
      ];

      const provider = new MavisExecutorProvider({
        client,
        config: { ...baseConfig, mavisBridgeSessionId: 'mvs_parent' } as Config,
        agentName: 'mavis',
        pollIntervalMs: 10,
        hardTimeoutMs: 100,
        quietTimeoutMs: 30,
        maxDiffBytes: 1024,
      });
      await provider.preDispatch(params({ sessionId, prompt: 'new prompt' }));

      const events: string[] = [];
      const stream = new ReadableStream<string>({
        start: (controller) => {
          (provider as unknown as { _ctrl?: ReadableStreamDefaultController<string> })._ctrl = controller;
        },
      });
      void stream;
      const ctrl = (provider as unknown as { _ctrl: ReadableStreamDefaultController<string> })._ctrl;
      const realEnqueue = ctrl.enqueue.bind(ctrl);
      ctrl.enqueue = (value: string) => {
        events.push(value);
        realEnqueue(value);
      };

      const result = await provider.streamUntilFinish(params({ sessionId, prompt: 'new prompt' }), provider.binding!, ctrl);
      assert.equal(result.terminal, 'finished');
      assert.equal(events.some((event) => event.includes('hello from communication')), true);
      assert.equal(client.sendCalls[0]?.from, 'mvs_parent');
    });

    it('keeps polling past quietTimeoutMs so late communication replies can finish the turn', async () => {
      const client = new FakeMavisClient();
      const oldTime = new Date(Date.now() - 60_000).toISOString();
      const started: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'started',
          lastActiveAt: oldTime,
          updatedAt: oldTime,
          model: baseModel,
        },
      };
      client.infoResponses = [started, started, started, started, started];
      client.messagesResponses = [[], [], []];
      client.communicationMessagesResponses = [
        [],
        [
          {
            id: 121,
            from_session: 'mvs_new_1',
            to_session: 'mvs_parent',
            command: 'prompt',
            content: 'late communication reply',
            status: 'done',
            time_created: Date.now() + 1_000,
          },
        ],
      ];

      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client, {
        mavisBridgeSessionId: 'mvs_parent',
        mavisHardTimeoutMs: 120,
        mavisQuietTimeoutMs: 1,
      } as Partial<typeof baseConfig>);
      const result = await provider.streamUntilFinish(params({ sessionId }), provider.binding!, ctrl);
      assert.equal(result.terminal, 'finished');
      assert.equal(client.sendCalls.some((call) => call.command === 'abort'), false);
    });

    it('returns terminal=timeout when hardTimeoutMs elapses without terminal status', async () => {
      const client = new FakeMavisClient();
      // Empty infoResponses means each info() returns a default `finished`
      // session — but with `lastActiveAt` undefined, the quiet-timeout
      // branch will fire first. To force hard timeout, we make every
      // info() throw so the loop never sees a terminal status.
      client.infoResponses = [];
      const origInfo = client.info.bind(client);
      client.info = async (sessionId: string) => {
        // Override to always throw — keeps the poll loop spinning until
        // hardTimeoutMs (50ms in this test) fires.
        void sessionId;
        throw new Error('simulated transient');
      };
      void origInfo;
      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client);
      const binding = provider.binding!;
      const result = await provider.streamUntilFinish(params({ sessionId }), binding, ctrl);
      assert.equal(result.terminal, 'timeout');
      assert.equal(result.errorCode, 'timeout');
      assert.match(result.errorShort ?? '', /超时/);
    });

    it('returns terminal=aborted when mavis reports status=aborted', async () => {
      const client = new FakeMavisClient();
      const aborted: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'aborted',
          model: baseModel,
        },
      };
      client.infoResponses = [aborted, aborted];
      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client);
      const binding = provider.binding!;
      const result = await provider.streamUntilFinish(params({ sessionId }), binding, ctrl);
      assert.equal(result.terminal, 'aborted');
      assert.equal(result.errorCode, 'aborted');
      assert.match(result.errorShort ?? '', /中止/);
    });

    it('returns terminal=error when mavis reports status=error', async () => {
      const client = new FakeMavisClient();
      const errored: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'error',
          model: baseModel,
        },
      };
      client.infoResponses = [errored, errored];
      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client);
      const binding = provider.binding!;
      const result = await provider.streamUntilFinish(params({ sessionId }), binding, ctrl);
      assert.equal(result.terminal, 'error');
      assert.equal(result.errorCode, 'remote_error');
      assert.match(result.errorShort ?? '', /远端任务失败/);
    });

    it('returns terminal=partial_result when status=finished but messages() throws', async () => {
      const client = new FakeMavisClient();
      const finished: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'finished',
          model: baseModel,
        },
      };
      client.infoResponses = [finished, finished];
      const origMessages = client.messages.bind(client);
      client.messages = async () => {
        void origMessages;
        throw new Error('simulated messages fetch failure');
      };
      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client);
      const binding = provider.binding!;
      const result = await provider.streamUntilFinish(params({ sessionId }), binding, ctrl);
      assert.equal(result.terminal, 'partial_result');
      assert.equal(result.errorCode, 'partial_result');
      assert.match(result.errorShort ?? '', /消息拉取失败/);
    });

    it('returns terminal=partial_result when status=finished but no assistant text', async () => {
      const client = new FakeMavisClient();
      const finished: MavisSessionInfo = {
        session: {
          sessionId: 'mvs_new_1',
          agentName: 'mavis',
          agentRole: 'agent',
          displayName: 'mavis',
          title: 't',
          status: 'finished',
          model: baseModel,
        },
      };
      client.infoResponses = [finished, finished];
      client.messagesResponses = [[]];
      const { provider, ctrl, sessionId } = await makeProviderWithBinding(client);
      const binding = provider.binding!;
      const result = await provider.streamUntilFinish(params({ sessionId }), binding, ctrl);
      assert.equal(result.terminal, 'partial_result');
      assert.equal(result.errorCode, 'partial_result');
      assert.match(result.errorShort ?? '', /未返回文本/);
    });
  });
});
