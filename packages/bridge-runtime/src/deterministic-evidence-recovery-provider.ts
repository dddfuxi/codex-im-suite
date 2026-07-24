import path from 'node:path';

import type { LLMProvider } from 'claude-to-im/host';
import { extractAbsolutePathCandidates } from 'claude-to-im/workspace';

import {
  buildCtiFinalToolResponseEnvelope,
  buildDeterministicToolAnswer,
  buildVisibleToolOutcomeFallback,
  executeJsonToolRequest,
  planDeterministicJsonToolRequest,
  validateJsonToolRequest,
  type JsonToolRequest,
  type JsonToolResult,
} from './local-agent-tool-protocol.js';
import { maskSecrets } from './logger.js';
import { resolveProviderWorkspace } from './provider-workspace.js';
import { sseEvent } from './sse-utils.js';

type StreamParams = Parameters<LLMProvider['streamChat']>[0];

interface PreparedRecovery {
  request: JsonToolRequest;
  reason: string;
}

/**
 * 在 Agent 首轮没有产生工具证据后，为明确、低风险的本地只读请求提供一次受控恢复。
 *
 * 首轮仍由 Agent 自主选择工具；只有 conversation-engine 发起 no-evidence retry 时，
 * 才允许本层复用 runtime 已有的确定性计划、工作区校验和只读工具执行器。写入、
 * MCP、Unity、产物或无法唯一规划的请求继续交给原 Provider，不在这里放宽证据门禁。
 */
export class DeterministicEvidenceRecoveryProvider implements LLMProvider {
  constructor(private readonly provider: LLMProvider) {}

  streamChat(params: StreamParams): ReturnType<LLMProvider['streamChat']> {
    const recovery = this.prepareRecovery(params);
    if (!recovery) return this.provider.streamChat(params);

    return new ReadableStream<string>({
      start: (controller) => {
        const toolId = `runtime-read-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `JsonTool:${recovery.request.tool}`,
          input: recovery.request.args,
        }));

        const result = executeJsonToolRequest(recovery.request);
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: JSON.stringify(result, null, 2),
          is_error: !result.ok,
        }));
        controller.enqueue(sseEvent('status', {
          provider: 'runtime_evidence_recovery',
          requiredEvidenceKind: params.executionRequirement?.kind,
          evidenceProtocol: 'json_tool_request',
          requestedTool: recovery.request.tool,
          executedTool: recovery.request.tool,
          jsonToolFallbackUsed: true,
          evidenceSatisfied: result.ok,
          recoveryReason: recovery.reason,
        }));

        const body = result.ok
          ? buildDeterministicToolAnswer(result)
            || buildVisibleToolOutcomeFallback(params.prompt, [{ request: recovery.request, result }])
          : this.buildFailureReply(result);
        controller.enqueue(sseEvent('text', buildCtiFinalToolResponseEnvelope(body, { images: [], files: [] }, 'markdown')));
        controller.enqueue(sseEvent('result', {}));
        controller.close();
      },
    });
  }

  private prepareRecovery(params: StreamParams): PreparedRecovery | null {
    if (params.interactionMode !== 'agent') return null;
    if (params.noEvidenceRetryAttempted !== true) return null;
    if (params.executionRequirement?.kind !== 'local_read_required') return null;
    if (params.executionRequirement.strictToolEvidence === false) return null;
    if (!params.workspacePlan) return null;

    // workspacePlan 是本轮唯一权限事实源；不要把旧 workingDirectory 或全局允许根
    // 重新加入只读恢复范围，否则会让证据恢复层意外扩大本轮可访问边界。
    const workspace = resolveProviderWorkspace(params);
    if (!workspace.workingDirectory || workspace.allowedRoots.length === 0) return null;
    const explicitPaths = extractAbsolutePathCandidates(params.prompt);
    if (explicitPaths.some((candidate) => !workspace.allowedRoots.some((root) => this.isSameOrChildPath(candidate, root)))) {
      return null;
    }

    const plan = planDeterministicJsonToolRequest(params.prompt, {
      workingDirectory: workspace.workingDirectory,
      contextText: [params.systemPrompt, params.priorityTurnContext].filter(Boolean).join('\n'),
      requirementKind: 'local_read_required',
    });
    if (!plan) return null;
    if (!this.isExplicitBoundedReadRequest(params.prompt, plan.request.tool)) return null;

    const validation = validateJsonToolRequest(plan.request, {
      workingDirectory: workspace.workingDirectory,
      allowedRoots: workspace.allowedRoots,
      contextText: [params.systemPrompt, params.priorityTurnContext].filter(Boolean).join('\n'),
    });
    if (!validation.ok) return null;
    if (!['list_dir', 'read_file', 'search_files'].includes(validation.request.tool)) return null;

    return {
      request: validation.request,
      reason: plan.reason,
    };
  }

  private buildFailureReply(result: JsonToolResult): string {
    return `未完成：自动只读检查执行失败：${maskSecrets(result.error || '工具没有返回具体错误。')}`;
  }

  private isSameOrChildPath(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private isExplicitBoundedReadRequest(prompt: string, tool: JsonToolRequest['tool']): boolean {
    const text = prompt.normalize('NFKC');
    if (tool === 'list_dir') {
      return /(工作目录|当前目录|本地目录|工作区|项目结构|目录|文件夹|folders?|director(?:y|ies)|\bdir\b)/iu.test(text)
        || /(列出|列一下|有哪些|有什么|查看|看一下).{0,16}(文件|子项|项目内容)/iu.test(text);
    }
    if (tool === 'read_file') {
      return /(读取|读一下|打开|read|open).{0,24}(文件|file|\.[a-z0-9]{1,8}\b)/iu.test(text)
        || /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[^\r\n]+\.[a-z0-9]{1,8}\b/iu.test(text);
    }
    if (tool === 'search_files') return /(搜索|搜一下|查找|search|find|grep|\brg\b)/iu.test(text);
    return false;
  }
}
