/**
 * ExecutorProviderRegistry — real dispatch of external agent executors.
 *
 * v3 design (replace the v1 "construct-time swap of fallbackProvider"
 * pattern): after `selectExecutor` returns an `ExecutorSelection`, this
 * registry is consulted. If the selected executor is a registered
 * `external` agent (currently only `mavis-agent`), we return THAT
 * provider instead of the default Codex one. Otherwise we fall through
 * to the default Codex provider.
 *
 * Critical contract (v3.1 / v3.2 / v3.3 / v3.4):
 * - Registry accepts `ExecutorRequest` (built by the caller); it does
 *   **not** re-derive fields from `StreamChatParams`.
 * - Registry does **not** accept `sessionDefaultId` as a 4th argument.
 *   The caller must fold `sessionDefaultId` into
 *   `ExecutorRequest.requestedExecutorId` itself, with the priority:
 *     hintedExecutorId ?? sessionDefaultId ?? undefined
 *   (v3.3 P1 — `@hint` strictly wins over `sessionDefault`).
 */

import type { LLMProvider } from 'claude-to-im/host';

import type { Config } from './config.js';
import { selectExecutor } from './executor-registry.js';
import type {
  ExecutorRequest,
  ExecutorSelection,
} from './executor-types.js';

export interface ResolvedDispatch {
  provider: LLMProvider;
  selection: ExecutorSelection;
  isExternal: boolean;
}

const INTERNAL_EXECUTOR_IDS = new Set<string>(['codex', 'claude-cli', 'codex-oss-ollama']);

export class ExecutorProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  /** One-time registration, typically from `main.ts` at daemon start. */
  register(executorId: string, provider: LLMProvider): void {
    if (!executorId || !provider) return;
    this.providers.set(executorId, provider);
  }

  unregister(executorId: string): void {
    this.providers.delete(executorId);
  }

  has(executorId: string): boolean {
    return this.providers.has(executorId);
  }

  listExecutorIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Returns the provider instance for the chosen executor:
   * - If `selectExecutor` picks an external executor (anything other
   *   than `codex` / `claude-cli` / `codex-oss-ollama`) AND we have a
   *   registered provider for it → return that provider with
   *   `isExternal: true`.
   * - Otherwise → return `defaultProvider` with `isExternal: false`.
   *
   * `defaultProvider` is the Codex main chain. It is **only** used when
   * `isExternal === false`; when the chosen executor is external, the
   * default is ignored entirely (this is the key fix vs. the v1
   * "construct-time swap of fallbackProvider" pattern).
   */
  resolveForRequest(
    config: Config,
    request: ExecutorRequest,
    defaultProvider: LLMProvider,
  ): ResolvedDispatch {
    const selection = selectExecutor(config, request);
    const external = this.providers.get(selection.executor.id);
    if (external && !INTERNAL_EXECUTOR_IDS.has(selection.executor.id)) {
      return { provider: external, selection, isExternal: true };
    }
    return { provider: defaultProvider, selection, isExternal: false };
  }
}
