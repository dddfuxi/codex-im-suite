import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendWorkflowEvent,
  completeWorkflowRun,
  failWorkflowRun,
  claimNextWorkflowRetry,
  markInterruptedWorkflowRuns,
  readWorkflowStatus,
  recordWorkflowRecoveryInfo,
  requestWorkflowRetry,
  setWorkflowExecutor,
  startWorkflowRun,
} from '../workflow-status.js';
import { readWorkflowFailureLedger } from '../workflow-failure-ledger.js';

const retryRecovery = {
  turnId: 'turn-retry',
  executionRequirement: { kind: 'none' as const, reason: 'test', requiredToolFamilies: [] },
};

describe('workflow status store', () => {
  let tempHome = '';
  const originalCtiHome = process.env.CTI_HOME;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-workflow-status-'));
    process.env.CTI_HOME = tempHome;
  });

  afterEach(() => {
    if (originalCtiHome === undefined) delete process.env.CTI_HOME;
    else process.env.CTI_HOME = originalCtiHome;
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it('records ordered workflow stages and completion', () => {
    const run = startWorkflowRun({
      sessionId: 'session-1',
      prompt: '帮我看看 git 状态',
      channelType: 'feishu',
      chatId: 'chat-1',
    });
    setWorkflowExecutor(run.id, 'codex', '测试选择 Codex');
    appendWorkflowEvent(run.id, 'executing', 'executor.started', '开始执行');
    const completed = completeWorkflowRun(run.id);
    assert.equal(completed?.status, 'succeeded');
    assert.equal(completed?.stage, 'delivered');
    assert.equal(completed?.executorId, 'codex');
    assert.deepEqual(
      completed?.events.map((event) => event.stage),
      ['received', 'routed', 'executing', 'delivered'],
    );
  });

  it('promotes execution summary and token usage into top-level workflow fields', () => {
    const run = startWorkflowRun({
      sessionId: 'session-telemetry-success',
      prompt: '截一张 Unity 视图',
      channelType: 'feishu',
      chatId: 'chat-telemetry-success',
    });
    setWorkflowExecutor(run.id, 'codex', 'telemetry success');
    appendWorkflowEvent(run.id, 'finalizing', 'execution.evidence', '执行证据已记录', {
      provider: 'codex',
      codexProfile: 'local_primary',
      modelSource: 'local_api',
      attemptedSources: ['local_api', 'external_api'],
      selectedSource: 'local_api',
      model: 'qwen2.5-coder:7b',
      baseUrl: 'http://127.0.0.1:11434',
      requiredEvidenceKind: 'local_read_required',
      evidenceSatisfied: true,
      noEvidenceRetryAttempted: false,
      requiredToolFamilies: ['shell', 'read', 'search'],
      toolUseCount: 1,
      toolResultCount: 1,
      successfulToolResultCount: 1,
      failedToolResultCount: 0,
      toolNames: ['JsonTool:list_dir'],
      evidenceProtocol: 'json_tool_request',
      requestedTool: 'list_dir',
      executedTool: 'list_dir',
      jsonToolRetryAttempted: true,
      jsonToolFallbackUsed: true,
      shellExitCode: 0,
      shellDurationMs: 1234,
      promptProfile: 'light_chat',
      tokenUsage: {
        input_tokens: 90,
        output_tokens: 34,
      },
    });

    const completed = completeWorkflowRun(run.id);

    assert.equal(completed?.execution?.provider, 'codex');
    assert.equal(completed?.execution?.codexProfile, 'local_primary');
    assert.equal(completed?.execution?.modelSource, 'local_api');
    assert.deepEqual(completed?.execution?.attemptedSources, ['local_api', 'external_api']);
    assert.equal(completed?.execution?.selectedSource, 'local_api');
    assert.equal(completed?.execution?.model, 'qwen2.5-coder:7b');
    assert.equal(completed?.execution?.requiredEvidenceKind, 'local_read_required');
    assert.equal(completed?.execution?.evidenceSatisfied, true);
    assert.equal(completed?.execution?.noEvidenceRetryAttempted, false);
    assert.deepEqual(completed?.execution?.requiredToolFamilies, ['shell', 'read', 'search']);
    assert.equal(completed?.execution?.toolUseCount, 1);
    assert.equal(completed?.execution?.toolResultCount, 1);
    assert.equal(completed?.execution?.successfulToolResultCount, 1);
    assert.equal(completed?.execution?.failedToolResultCount, 0);
    assert.deepEqual(completed?.execution?.toolNames, ['JsonTool:list_dir']);
    assert.equal(completed?.execution?.evidenceProtocol, 'json_tool_request');
    assert.equal(completed?.execution?.requestedTool, 'list_dir');
    assert.equal(completed?.execution?.executedTool, 'list_dir');
    assert.equal(completed?.execution?.jsonToolRetryAttempted, true);
    assert.equal(completed?.execution?.jsonToolFallbackUsed, true);
    assert.equal(completed?.execution?.shellExitCode, 0);
    assert.equal(completed?.execution?.shellDurationMs, 1234);
    assert.equal(completed?.execution?.promptProfile, 'light_chat');
    assert.equal(completed?.tokenUsage?.input_tokens, 90);
    assert.equal(completed?.tokenUsage?.output_tokens, 34);
    assert.equal(completed?.tokenUsage?.total_tokens, 124);
  });

  it('persists Codex SDK parameter evidence from workflow events', () => {
    const run = startWorkflowRun({
      sessionId: 'codex-profile',
      prompt: 'hello',
    });
    appendWorkflowEvent(run.id, 'finalizing', 'execution.evidence', '执行证据已记录', {
      requestedModel: 'gpt-5.4',
      submittedModel: 'gpt-5.4',
      modelMode: 'explicit',
      requestedReasoningEffort: 'xhigh',
      submittedReasoningEffort: 'xhigh',
      threadMode: 'fresh_profile_changed',
      parameterEvidence: 'sdk_thread_options',
    });

    const stored = readWorkflowStatus().runs.find((item) => item.id === run.id);

    assert.equal(stored?.execution?.requestedModel, 'gpt-5.4');
    assert.equal(stored?.execution?.submittedModel, 'gpt-5.4');
    assert.equal(stored?.execution?.submittedReasoningEffort, 'xhigh');
    assert.equal(stored?.execution?.threadMode, 'fresh_profile_changed');
    assert.equal(stored?.execution?.parameterEvidence, 'sdk_thread_options');
  });

  it('preserves structured input evidence receipts in workflow summaries', () => {
    const run = startWorkflowRun({
      sessionId: 'session-input-evidence',
      prompt: '分析一下图片里的关键信息',
      channelType: 'feishu',
      chatId: 'chat-input-evidence',
    });
    appendWorkflowEvent(run.id, 'finalizing', 'execution.evidence', '输入证据已记录', {
      provider: 'codex',
      requiredEvidenceKind: 'input_evidence_required',
      evidenceSatisfied: true,
      requiredInputEvidenceKinds: ['image'],
      requiredInputEvidenceIds: ['image-1'],
      acceptedInputEvidenceKinds: ['image'],
      acceptedInputEvidenceIds: ['image-1'],
      inputEvidenceProvider: 'codex',
      toolUseCount: 0,
      toolResultCount: 0,
      successfulToolResultCount: 0,
      failedToolResultCount: 0,
      toolNames: [],
    });

    const completed = completeWorkflowRun(run.id);
    assert.equal(completed?.execution?.requiredEvidenceKind, 'input_evidence_required');
    assert.equal(completed?.execution?.evidenceSatisfied, true);
    assert.deepEqual(completed?.execution?.requiredInputEvidenceKinds, ['image']);
    assert.deepEqual(completed?.execution?.requiredInputEvidenceIds, ['image-1']);
    assert.deepEqual(completed?.execution?.acceptedInputEvidenceKinds, ['image']);
    assert.deepEqual(completed?.execution?.acceptedInputEvidenceIds, ['image-1']);
    assert.equal(completed?.execution?.inputEvidenceProvider, 'codex');
  });

  it('records failed runs with error message', () => {
    const run = startWorkflowRun({
      sessionId: 'session-2',
      prompt: '触发失败',
    });
    const failed = failWorkflowRun(run.id, new Error('boom'));
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.stage, 'failed');
    assert.equal(failed?.error, 'boom');
    assert.ok(readWorkflowStatus().runs.some((item) => item.id === run.id));
  });

  it('keeps a monotonic, content-free failure watermark beyond the rolling workflow view', () => {
    const first = startWorkflowRun({ sessionId: 'ledger-1', prompt: '敏感正文一' });
    appendWorkflowEvent(first.id, 'executing', 'executor.started', '开始执行');
    failWorkflowRun(first.id, new Error('dynamic failure text one'));

    const second = startWorkflowRun({ sessionId: 'ledger-2', prompt: '敏感正文二' });
    appendWorkflowEvent(second.id, 'executing', 'executor.started', '开始执行');
    failWorkflowRun(second.id, new Error('dynamic failure text two'));

    const ledger = readWorkflowFailureLedger();
    assert.deepEqual(ledger.entries.map((entry) => entry.sequence), [1, 2]);
    assert.equal(ledger.nextSequence, 3);
    assert.equal(ledger.retainedFromSequence, 1);
    assert.equal(ledger.entries[0].fingerprint, ledger.entries[1].fingerprint);
    const raw = fs.readFileSync(path.join(tempHome, 'runtime', 'workflow-failure-ledger.json'), 'utf8');
    assert.doesNotMatch(raw, /敏感正文|dynamic failure text/u);
  });

  it('records restart-during-execution as a stable runtime failure code', () => {
    const run = startWorkflowRun({ sessionId: 'ledger-restart', prompt: '执行任务' });
    appendWorkflowEvent(run.id, 'executing', 'executor.started', '开始执行');
    markInterruptedWorkflowRuns('runtime-after-restart');

    const entry = readWorkflowFailureLedger().entries.at(-1);
    assert.equal(entry?.kind, 'restart_interrupted');
    assert.equal(entry?.stage, 'executing');
    assert.deepEqual(entry?.failureCodes, ['runtime.restart_during_execution']);
  });

  it('retries transient Windows file locks while writing workflow status', () => {
    const originalRenameSync = fs.renameSync;
    let attempts = 0;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('resource busy or locked') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;
    try {
      const run = startWorkflowRun({
        sessionId: 'session-ebusy',
        prompt: 'write status while another reader is active',
      });

      assert.ok(readWorkflowStatus().runs.some((item) => item.id === run.id));
      assert.equal(attempts, 2);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = originalRenameSync;
    }
  });

  it('keeps execution summary on failed runs when no token usage was reported', () => {
    const run = startWorkflowRun({
      sessionId: 'session-telemetry-failed',
      prompt: '触发本地模型失败',
      channelType: 'feishu',
      chatId: 'chat-telemetry-failed',
    });
    appendWorkflowEvent(run.id, 'finalizing', 'execution.evidence', '执行证据已记录', {
      provider: 'codex',
      modelSource: 'official',
      model: 'gpt-5',
    });

    const failed = failWorkflowRun(run.id, new Error('timeout'));

    assert.equal(failed?.execution?.provider, 'codex');
    assert.equal(failed?.execution?.modelSource, 'official');
    assert.equal(failed?.execution?.model, 'gpt-5');
    assert.equal(failed?.tokenUsage, undefined);
  });

  it('keeps workflow JSON valid when truncation meets an emoji surrogate pair', () => {
    const prompt = `${'x'.repeat(176)}🇨🇳 后续文本`;
    const run = startWorkflowRun({
      sessionId: 'session-unicode-preview',
      prompt,
    });
    appendWorkflowEvent(run.id, 'executing', 'unicode.evidence', '包含孤立代理项的外部数据', {
      malformed: `before-${String.fromCharCode(0xD83C)}-after`,
    });

    const statusPath = path.join(tempHome, 'runtime', 'workflow-runs.json');
    const raw = fs.readFileSync(statusPath, 'utf8');
    const parsed = JSON.parse(raw) as { runs: Array<{ promptPreview: string; events: Array<{ data?: { malformed?: string } }> }> };
    const stored = parsed.runs.at(-1);

    assert.ok(stored?.promptPreview.endsWith('...'));
    assert.doesNotMatch(stored?.promptPreview || '', /[\uD800-\uDFFF]$/u);
    assert.equal(stored?.events.at(-1)?.data?.malformed, 'before-\uFFFD-after');
  });

  it('backs up and repairs a historical workflow file with malformed UTF-16', () => {
    const runtimeDir = path.join(tempHome, 'runtime');
    const statusPath = path.join(runtimeDir, 'workflow-runs.json');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify({
      protocol: 'workflow-runtime/v1',
      updatedAt: '2026-08-01T00:00:00.000Z',
      runs: [{ id: 'legacy-unicode', promptPreview: String.fromCharCode(0xD83C), events: [] }],
    }), 'utf8');

    const status = readWorkflowStatus();
    const repairedRaw = fs.readFileSync(statusPath, 'utf8');
    const backups = fs.readdirSync(runtimeDir).filter((name) => name.startsWith('workflow-runs.json.unicode-repair-'));

    assert.equal(status.runs[0]?.promptPreview, '\uFFFD');
    assert.doesNotMatch(repairedRaw, /\\ud83c/iu);
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(path.join(runtimeDir, backups[0]), 'utf8'), /\\ud83c/iu);
  });

  it('merges provider and tool failure diagnostics without exposing raw paths as codes', () => {
    const run = startWorkflowRun({
      sessionId: 'session-layered-failure',
      prompt: '执行桌面工具',
    });
    appendWorkflowEvent(run.id, 'finalizing', 'execution.evidence', '执行证据已记录', {
      failedToolResultCount: 2,
      failedToolErrors: [
        "Cannot find path 'C:\\secret\\tool\\SKILL.md' because it does not exist.",
        'ERR_UNSUPPORTED_ESM_URL_SCHEME',
      ],
      failureDiagnostics: [
        {
          source: 'tool',
          category: 'dependency_unavailable',
          code: 'tool.dependency_path_missing',
          summary: '工具依赖路径不存在或未安装',
        },
        {
          source: 'tool',
          category: 'runtime_incompatible',
          code: 'tool.module_loader_incompatible',
          summary: '工具模块加载方式与当前运行时不兼容',
        },
      ],
    });

    const failed = failWorkflowRun(run.id, new Error('Codex 登录已失效，请重新登录。'));
    const codes = failed?.execution?.failureDiagnostics?.map((item) => item.code);

    assert.deepEqual(codes, [
      'tool.dependency_path_missing',
      'tool.module_loader_incompatible',
      'provider.authentication_requires_user_action',
    ]);
    assert.ok(codes?.every((code) => !code.includes('secret')));
    assert.deepEqual(failed?.events.at(-1)?.data?.failureCodes, codes);
  });

  it('marks interrupted running runs as recoverable when retry input was persisted', () => {
    const run = startWorkflowRun({
      sessionId: 'session-recoverable',
      prompt: '继续处理这条消息',
      channelType: 'feishu',
      chatId: 'chat-recoverable',
    });
    recordWorkflowRecoveryInfo(run.id, {
      ...retryRecovery,
      prompt: '继续处理这条消息',
      workingDirectory: 'C:\\workspace',
      model: 'gpt-test',
      permissionMode: 'default',
      maxAutoAttempts: 2,
    });

    const marked = markInterruptedWorkflowRuns('runtime-next');
    const recovered = marked.find((item) => item.id === run.id);

    assert.equal(recovered?.status, 'retry_pending');
    assert.equal(recovered?.stage, 'failed');
    assert.equal(recovered?.recovery?.kind, 'recoverable');
    assert.equal(recovered?.retry?.status, 'auto_pending');
    assert.equal(recovered?.retry?.attempts, 0);
    assert.equal(recovered?.recovery?.input?.prompt, '继续处理这条消息');
  });

  it('persists Feishu sender metadata for cloud document retry prechecks', () => {
    const run = startWorkflowRun({
      sessionId: 'session-feishu-cloud-retry',
      prompt: '总结 https://example.feishu.cn/sheets/sht_abc',
      channelType: 'feishu',
      chatId: 'oc_retry',
    });
    recordWorkflowRecoveryInfo(run.id, {
      ...retryRecovery,
      prompt: '总结 https://example.feishu.cn/sheets/sht_abc',
      workingDirectory: 'C:\\workspace',
      channelType: 'feishu',
      chatId: 'oc_retry',
      userId: 'ou_liudan',
      userDisplayName: '刘丹',
      messageId: 'm_retry',
      maxAutoAttempts: 1,
    });

    const status = readWorkflowStatus();
    const recovered = status.runs.find((item) => item.id === run.id);

    assert.equal(recovered?.recovery?.input?.userId, 'ou_liudan');
    assert.equal(recovered?.recovery?.input?.userDisplayName, '刘丹');
    assert.equal(recovered?.recovery?.input?.messageId, 'm_retry');
  });

  it('marks interrupted running runs without retry input as not recoverable', () => {
    const run = startWorkflowRun({
      sessionId: 'session-not-recoverable',
      prompt: '缺少恢复信息',
    });

    const marked = markInterruptedWorkflowRuns('runtime-next');
    const recovered = marked.find((item) => item.id === run.id);

    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.stage, 'failed');
    assert.equal(recovered?.recovery?.kind, 'not_recoverable');
    assert.equal(recovered?.retry?.status, 'unavailable');
  });

  it('does not auto-replay runs that already entered execution or a retry attempt', () => {
    const executing = startWorkflowRun({
      sessionId: 'session-executing-interrupted',
      prompt: '截一张当前 Unity 的图',
      channelType: 'feishu',
      chatId: 'chat-executing-interrupted',
    });
    recordWorkflowRecoveryInfo(executing.id, {
      ...retryRecovery,
      prompt: '截一张当前 Unity 的图',
      workingDirectory: 'C:\\unity\\ST3',
      maxAutoAttempts: 2,
    });
    appendWorkflowEvent(executing.id, 'executing', 'executor.executing', '执行器开始处理');

    const retrying = startWorkflowRun({
      sessionId: 'session-retrying-interrupted',
      prompt: '继续上一轮',
    });
    recordWorkflowRecoveryInfo(retrying.id, {
      ...retryRecovery,
      prompt: '继续上一轮',
      workingDirectory: 'C:\\workspace',
      maxAutoAttempts: 2,
    });
    requestWorkflowRetry(retrying.id, 'manual');
    claimNextWorkflowRetry('worker-before-restart');

    const marked = markInterruptedWorkflowRuns('runtime-after-restart');
    const executingAfter = marked.find((item) => item.id === executing.id);
    const retryingAfter = marked.find((item) => item.id === retrying.id);

    assert.equal(executingAfter?.status, 'failed');
    assert.equal(executingAfter?.recovery?.kind, 'not_recoverable');
    assert.match(executingAfter?.recovery?.reason || '', /禁止跨重启自动重放/);
    assert.equal(retryingAfter?.status, 'failed');
    assert.equal(retryingAfter?.retry?.status, 'unavailable');
    assert.equal(claimNextWorkflowRetry('worker-after-restart'), null);
  });

  it('lets the control panel request and claim a manual retry for a failed run', () => {
    const run = startWorkflowRun({
      sessionId: 'session-manual',
      prompt: '手动重试这条消息',
      channelType: 'feishu',
      chatId: 'chat-manual',
    });
    recordWorkflowRecoveryInfo(run.id, {
      ...retryRecovery,
      prompt: '手动重试这条消息',
      workingDirectory: 'C:\\workspace',
      maxAutoAttempts: 1,
    });
    failWorkflowRun(run.id, new Error('temporary failure'));

    const pending = requestWorkflowRetry(run.id, 'manual');
    assert.equal(pending?.status, 'retry_pending');
    assert.equal(pending?.retry?.status, 'manual_pending');

    const claimed = claimNextWorkflowRetry('worker-1');
    assert.equal(claimed?.id, run.id);
    assert.equal(claimed?.status, 'retrying');
    assert.equal(claimed?.retry?.status, 'retrying');
    assert.equal(claimed?.retry?.claimedBy, 'worker-1');
  });

  it('does not auto-claim stale interrupted runs after the auto-retry age window has passed', () => {
    const oldMaxAge = process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS;
    process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS = '1';
    try {
      const run = startWorkflowRun({
        sessionId: 'session-stale-auto-retry',
        prompt: '桥接断开后继续旧任务',
        channelType: 'feishu',
        chatId: 'chat-stale-auto-retry',
      });
      recordWorkflowRecoveryInfo(run.id, {
        ...retryRecovery,
        prompt: '桥接断开后继续旧任务',
        workingDirectory: 'C:\\workspace',
        maxAutoAttempts: 1,
      });

      const marked = markInterruptedWorkflowRuns('runtime-stale-window');
      const recovered = marked.find((item) => item.id === run.id);
      assert.equal(recovered?.status, 'retry_pending');
      assert.equal(recovered?.retry?.status, 'auto_pending');

      const until = Date.now() + 10;
      while (Date.now() < until) {
        // wait for the retry window to expire without relying on file mutation
      }

      const claimed = claimNextWorkflowRetry('worker-stale');
      assert.equal(claimed, null);
    } finally {
      if (oldMaxAge === undefined) delete process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS;
      else process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS = oldMaxAge;
    }
  });
});
