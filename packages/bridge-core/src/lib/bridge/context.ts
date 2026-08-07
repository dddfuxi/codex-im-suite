/**
 * Bridge Context — dependency injection container for host interfaces.
 *
 * All bridge modules access host services through this context instead
 * of importing directly from the host application.
 *
 * The host initializes the context once at startup via `initBridgeContext()`.
 * Bridge modules access it via `getBridgeContext()`.
 */

import type {
  BridgeStore,
  LLMProvider,
  PermissionGateway,
  LifecycleHooks,
  ReminderActionHost,
  ScheduledTaskActionHost,
  BridgeControlHost,
  ExtensionCatalogHost,
  FeishuCloudDocumentHost,
  FeishuCliUserAuthHost,
  FeishuOAuthManualHost,
  MemoryIntentHost,
  StickerSemanticEvolutionHost,
  AgentHomeHost,
  SelfMaintenanceHost,
  TurnReferenceResolverHost,
  TurnStorageHost,
  ArtifactEncodingInspectorHost,
  AgentCollaborationHost,
  ChoicePromptStateHost,
  SpeechHost,
  SingingHost,
} from './host.js';

export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  lifecycle: LifecycleHooks;
  reminders?: ReminderActionHost;
  scheduledTasks?: ScheduledTaskActionHost;
  bridgeControl?: BridgeControlHost;
  extensions?: ExtensionCatalogHost;
  feishuCloudDocuments?: FeishuCloudDocumentHost;
  feishuCliUserAuth?: FeishuCliUserAuthHost;
  feishuOAuth?: FeishuOAuthManualHost;
  memoryIntents?: MemoryIntentHost;
  stickerSemantics?: StickerSemanticEvolutionHost;
  agentHome?: AgentHomeHost;
  selfMaintenance?: SelfMaintenanceHost;
  turnReferences?: TurnReferenceResolverHost;
  turnStorage?: TurnStorageHost;
  artifactEncoding?: ArtifactEncodingInspectorHost;
  agentCollaboration?: AgentCollaborationHost;
  choicePrompts?: ChoicePromptStateHost;
  /** 可选 Runtime 本地语音 Host；缺失时语音入口失败关闭为可行动文字提示。 */
  speech?: SpeechHost;
  /** 可选独立歌声 Host；缺失时唱歌请求只回退完整文字，绝不调用 TTS 冒充。 */
  singing?: SingingHost;
}

const CONTEXT_KEY = '__bridge_context__';

/**
 * Initialize the bridge context with host-provided implementations.
 * Must be called once before any bridge module is used.
 */
export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
}

/**
 * Get the current bridge context.
 * Throws if the context has not been initialized.
 */
export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY] as BridgeContext | undefined;
  if (!ctx) {
    throw new Error(
      '[bridge] Context not initialized. Call initBridgeContext() before using bridge modules.',
    );
  }
  return ctx;
}

/**
 * Check whether the bridge context has been initialized.
 */
export function hasBridgeContext(): boolean {
  return !!(globalThis as Record<string, unknown>)[CONTEXT_KEY];
}
