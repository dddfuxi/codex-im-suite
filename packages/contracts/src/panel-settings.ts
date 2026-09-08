export const PANEL_SETTINGS_SNAPSHOT_PROTOCOL = 'cti-panel-settings-snapshot/v1' as const;
export const PANEL_SETTINGS_UPDATE_PROTOCOL = 'cti-panel-settings-update-receipt/v1' as const;

export type PanelSettingsScalar = string | number | boolean;
export type PanelSettingValueType = 'string' | 'number' | 'boolean' | 'path' | 'path_list' | 'enum' | 'secret_status';

/** 控制面板 settings.read 的共享 wire 类型。敏感值仍只暴露 masked/set 状态。 */
export interface PanelSettingsStateContract {
  defaultWorkDir: string;
  allowedRoots: string;
  memoryRepo: string;
  additionalDirs: string;
  replyStyleHint: string;
  defaultExecutorId: string;
  localAiKind: string;
  localAiBaseUrl: string;
  ollamaModelsDir: string;
  localAiModel: string;
  localAiApiKeyAction: 'keep' | 'set' | 'clear';
  localAiApiKeyValue: string;
  localAiApiKeyMasked: string;
  localAiApiKeySet: boolean;
  localAiTimeoutMs: string;
  codexModelSource: string;
  codexRoutingMode: string;
  codexApiFallbackChain: string;
  codexBaseUrl: string;
  codexModel: string;
  codexPassModel: boolean;
  codexReasoningEffort: string;
  memoryOptimizerEnabled: boolean;
  memoryOptimizerIntervalDays: string;
  memoryOptimizerModelSource: string;
  codexApiKeyAction: 'keep' | 'set' | 'clear';
  codexApiKeyValue: string;
  codexApiKeyMasked: string;
  codexApiKeySet: boolean;
  safetyPolicyProfile: string;
}

export interface PanelSettingDescriptorContract {
  key: string;
  label: string;
  group: string;
  type: PanelSettingValueType;
  writable: boolean;
  restartRequired: boolean;
  enumValues?: string[];
  minimum?: number;
  maximum?: number;
}

export interface PanelSettingEntryContract extends PanelSettingDescriptorContract {
  value: PanelSettingsScalar;
}

export interface PanelSettingsSnapshotContract {
  protocol: typeof PANEL_SETTINGS_SNAPSHOT_PROTOCOL;
  version: string;
  generatedAt: string;
  settings: PanelSettingEntryContract[];
}

export interface PanelSettingChangeContract {
  key: string;
  value: PanelSettingsScalar;
}

export interface PanelSettingAppliedChangeContract {
  key: string;
  previousValue: PanelSettingsScalar;
  value: PanelSettingsScalar;
}

export interface PanelSettingsUpdateReceiptContract {
  protocol: typeof PANEL_SETTINGS_UPDATE_PROTOCOL;
  ok: boolean;
  written: boolean;
  restartRequired: boolean;
  version: string;
  applied: PanelSettingAppliedChangeContract[];
  snapshot: PanelSettingsSnapshotContract;
  error?: string;
}
