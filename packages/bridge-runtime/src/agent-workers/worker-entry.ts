import readline from 'node:readline';

import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentWorkerMessage,
  CollaborationAgentManifest,
} from '@codex-im-suite/contracts';

import { collectRestrictedProviderJson, createRestrictedAgentProvider, type RestrictedWorkerProviderConfig } from './restricted-provider.js';
import { buildAgentTaskPrompt, getAgentTaskResponseSchema } from './task-prompts.js';

interface WorkerBootstrapConfig {
  workerId: string;
  provider: RestrictedWorkerProviderConfig;
  manifests: CollaborationAgentManifest[];
}

function writeProtocol(message: AgentWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function stderrLog(...args: unknown[]): void {
  process.stderr.write(`${args.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(' ')}\n`);
}

console.log = stderrLog;
console.info = stderrLog;
console.debug = stderrLog;
console.warn = stderrLog;

function readBootstrap(): WorkerBootstrapConfig {
  const encoded = process.env.CTI_AGENT_WORKER_CONFIG_B64 || '';
  if (!encoded) throw new Error('missing_worker_bootstrap');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as WorkerBootstrapConfig;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try next bounded candidate
    }
  }
  return null;
}

const bootstrap = readBootstrap();
const manifests = new Map(bootstrap.manifests.map((manifest) => [manifest.id, manifest]));
const provider = await createRestrictedAgentProvider(bootstrap.provider);
let activeTaskId = '';
let activeAbort: AbortController | null = null;

writeProtocol({
  protocol: 'codex-im-suite/agent-worker/v1',
  type: 'hello',
  workerId: bootstrap.workerId,
  pid: process.pid,
  at: new Date().toISOString(),
});

const heartbeat = setInterval(() => writeProtocol({
  protocol: 'codex-im-suite/agent-worker/v1',
  type: 'heartbeat',
  workerId: bootstrap.workerId,
  at: new Date().toISOString(),
  activeTaskId: activeTaskId || undefined,
}), 10_000);
heartbeat.unref();

async function runTask(request: AgentTaskRequest): Promise<AgentTaskResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const manifest = manifests.get(request.agentId);
  if (!manifest || !manifest.enabled || !manifest.capabilities.includes(request.capability)) {
    return {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId: request.runId,
      turnId: request.turnId,
      taskId: request.taskId,
      agentId: request.agentId,
      capability: request.capability,
      status: 'failed',
      findings: [],
      evidenceRefs: [],
      promptSections: [],
      metrics: { startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - startedMs },
      errorCode: 'unknown_or_disabled_agent',
      errorSummary: 'Worker 未找到匹配的只读 Agent Manifest。',
    };
  }
  activeAbort = new AbortController();
  try {
    const timeoutMs = Math.max(1, Math.min(manifest.timeoutMs, Date.parse(request.deadlineAt) - Date.now()));
    const collected = await collectRestrictedProviderJson(provider, {
      prompt: buildAgentTaskPrompt(request, manifest),
      systemPrompt: 'You are a restricted read-only specialist. Return strict JSON only.',
      responseSchema: getAgentTaskResponseSchema(request),
      sessionId: `${request.runId}:${request.taskId}`,
      timeoutMs,
      abortSignal: activeAbort.signal,
    });
    const output = extractJsonObject(collected.text);
    if (!output) throw new Error('invalid_agent_json');
    const endedAt = new Date().toISOString();
    const source = output as Record<string, unknown>;
    return {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId: request.runId,
      turnId: request.turnId,
      taskId: request.taskId,
      agentId: request.agentId,
      capability: request.capability,
      status: 'succeeded',
      findings: Array.isArray(source.findings) ? source.findings.filter((item): item is string => typeof item === 'string') : [],
      evidenceRefs: Array.isArray(source.evidenceRefs)
        ? source.evidenceRefs.filter((item): item is string => typeof item === 'string')
        : Array.isArray(source.primaryEvidenceIds)
          ? source.primaryEvidenceIds.filter((item): item is string => typeof item === 'string')
          : [],
      promptSections: Array.isArray(source.promptSections)
        ? source.promptSections.filter((item): item is AgentTaskResult['promptSections'][number] => Boolean(item && typeof item === 'object'))
        : [],
      output: source,
      metrics: {
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        modelSource: collected.modelSource,
        model: collected.model,
        inputTokens: collected.inputTokens,
        outputTokens: collected.outputTokens,
        totalTokens: collected.totalTokens,
      },
    };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const cancelled = activeAbort.signal.aborted;
    return {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId: request.runId,
      turnId: request.turnId,
      taskId: request.taskId,
      agentId: request.agentId,
      capability: request.capability,
      status: cancelled ? 'cancelled' : 'failed',
      findings: [],
      evidenceRefs: [],
      promptSections: [],
      metrics: { startedAt, endedAt, durationMs: Date.now() - startedMs },
      errorCode: cancelled ? 'task_cancelled' : 'agent_execution_failed',
      errorSummary: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
    };
  } finally {
    activeAbort = null;
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  void (async () => {
    let message: AgentWorkerMessage;
    try {
      message = JSON.parse(line) as AgentWorkerMessage;
    } catch {
      stderrLog('invalid worker message json');
      return;
    }
    if (message.protocol !== 'codex-im-suite/agent-worker/v1') return;
    if (message.type === 'shutdown') {
      activeAbort?.abort();
      clearInterval(heartbeat);
      process.exit(0);
    }
    if (message.type === 'cancel') {
      if (!activeTaskId || message.taskId === activeTaskId) activeAbort?.abort();
      return;
    }
    if (message.type !== 'task') return;
    if (activeTaskId) {
      stderrLog('worker received task while busy', message.request.taskId);
      return;
    }
    activeTaskId = message.request.taskId;
    const result = await runTask(message.request);
    writeProtocol({
      protocol: 'codex-im-suite/agent-worker/v1',
      type: 'result',
      workerId: bootstrap.workerId,
      result,
    });
    activeTaskId = '';
  })();
});
