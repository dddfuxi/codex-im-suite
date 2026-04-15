/**
 * Channel Router - resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';
import { isPathWithinAllowedRoots, splitWorkspacePathList } from './security/validators.js';

function getCurrentFingerprints(): { bridgeFingerprint: string; toolingFingerprint: string } {
  const { store } = getBridgeContext();
  return {
    bridgeFingerprint: store.getSetting('bridge_runtime_fingerprint') || '',
    toolingFingerprint: store.getSetting('bridge_tooling_fingerprint') || '',
  };
}

function getDefaultWorkingDirectory(): string {
  const { store } = getBridgeContext();
  return store.getSetting('bridge_default_work_dir') || process.env.HOME || '';
}

function getAllowedWorkspaceRoots(): string[] {
  const { store } = getBridgeContext();
  return splitWorkspacePathList(store.getSetting('bridge_allowed_workspace_roots'));
}

function rebindToFreshSession(existing: ChannelBinding, workingDirectoryOverride?: string): ChannelBinding {
  const { store } = getBridgeContext();
  const currentSession = store.getSession(existing.codepilotSessionId);
  const workingDirectory = workingDirectoryOverride
    || existing.workingDirectory
    || currentSession?.working_directory
    || getDefaultWorkingDirectory();
  const model = existing.model || currentSession?.model || '';

  const session = store.createSession(
    `Bridge: ${existing.chatId}`,
    model,
    currentSession?.system_prompt,
    workingDirectory,
    existing.mode,
  );

  if (currentSession?.provider_id) {
    store.updateSessionProviderId(session.id, currentSession.provider_id);
  }

  const { bridgeFingerprint, toolingFingerprint } = getCurrentFingerprints();
  return store.upsertChannelBinding({
    channelType: existing.channelType,
    chatId: existing.chatId,
    displayName: existing.displayName,
    chatType: existing.chatType,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory,
    model,
    mode: existing.mode,
    bridgeFingerprint,
    toolingFingerprint,
  });
}

function enforceWorkspacePolicy(existing: ChannelBinding): ChannelBinding {
  const currentSession = getBridgeContext().store.getSession(existing.codepilotSessionId);
  const workingDirectory = existing.workingDirectory || currentSession?.working_directory || '';
  const allowedRoots = getAllowedWorkspaceRoots();
  if (!workingDirectory || isPathWithinAllowedRoots(workingDirectory, allowedRoots)) {
    return existing;
  }
  return rebindToFreshSession(existing, getDefaultWorkingDirectory());
}

function refreshBindingForRuntimeChanges(existing: ChannelBinding): ChannelBinding {
  const { store } = getBridgeContext();
  const { bridgeFingerprint, toolingFingerprint } = getCurrentFingerprints();
  const toolingChanged = !!toolingFingerprint && existing.toolingFingerprint !== toolingFingerprint;
  if (toolingChanged) {
    return rebindToFreshSession(existing);
  }

  const bridgeChanged = !!bridgeFingerprint && existing.bridgeFingerprint !== bridgeFingerprint;
  if (bridgeChanged || !existing.bridgeFingerprint || !existing.toolingFingerprint) {
    store.updateChannelBinding(existing.id, {
      sdkSessionId: '',
      bridgeFingerprint: bridgeFingerprint || existing.bridgeFingerprint,
      toolingFingerprint: toolingFingerprint || existing.toolingFingerprint,
    });
    return store.getChannelBinding(existing.channelType, existing.chatId) ?? existing;
  }

  return existing;
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return refreshBindingForRuntimeChanges(enforceWorkspacePolicy(existing));
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const defaultCwd = workingDirectory
    || getDefaultWorkingDirectory();
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';
  const { bridgeFingerprint, toolingFingerprint } = getCurrentFingerprints();

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    displayName: address.displayName,
    chatType: address.chatType,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
    bridgeFingerprint,
    toolingFingerprint,
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;
  const { bridgeFingerprint, toolingFingerprint } = getCurrentFingerprints();

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    displayName: address.displayName,
    chatType: address.chatType,
    codepilotSessionId,
    workingDirectory: session.working_directory,
    model: session.model,
    bridgeFingerprint,
    toolingFingerprint,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active' | 'bridgeFingerprint' | 'toolingFingerprint'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
