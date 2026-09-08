import type {
  SpeechProviderCapability,
  SpeechProviderContract,
  SpeechState,
} from '@codex-im-suite/contracts/speech';

export interface SpeechProviderCatalogEntry {
  id: string;
  displayName: string;
  license: string;
  experimental: boolean;
  capabilities: SpeechProviderCapability[];
  componentIds: string[];
  diagnosticCode?: string;
}

/**
 * Provider 的能力与许可只在 Runtime 目录声明。面板只消费投影，不按模型名、
 * 固定句子或当前机器人复制一套能力判断。
 */
export const SPEECH_PROVIDER_CATALOG: readonly SpeechProviderCatalogEntry[] = [
  {
    id: 'qwen3_tts',
    displayName: 'Qwen3-TTS',
    license: 'Apache-2.0',
    experimental: false,
    capabilities: ['speech.text', 'speech.emotion', 'voice.zero_shot_clone'],
    componentIds: [
      'qwen3_tts_runtime',
      'qwen3-tts-12hz-1.7b-custom-voice',
      'qwen3-tts-12hz-0.6b-custom-voice',
      'qwen3-tts-12hz-1.7b-base',
      'qwen3-tts-12hz-0.6b-base',
    ],
  },
  {
    id: 'ace_step_1_5',
    displayName: 'ACE-Step 1.5',
    license: 'MIT',
    experimental: false,
    capabilities: ['singing.text_to_singing', 'singing.voice_conversion'],
    componentIds: ['ace_step_1_5', 'ace_step_1_5_models'],
  },
  {
    id: 'vevo2',
    displayName: 'Amphion Vevo2（实验 PoC）',
    license: 'CC BY-NC-ND 4.0',
    experimental: true,
    capabilities: [
      'speech.text',
      'speech.prosody_reference',
      'singing.text_to_singing',
      'singing.melody',
      'singing.voice_conversion',
      'voice.zero_shot_clone',
      'voice.cross_mode_identity',
    ],
    componentIds: ['vevo2_poc'],
    diagnosticCode: 'vevo2_fileset_not_locked',
  },
] as const;

export function projectSpeechProviders(input: {
  componentStates: Map<string, { state: SpeechState; diagnosticCode?: string }>;
  liveTtsProviderId: string;
  /** 当前 live TTS 的依赖、身份与性能联合门禁结果。 */
  liveTtsState: SpeechState;
  liveTtsDiagnostic?: string;
  activeSingingProviderId: string;
  singingState: SpeechState;
  singingDiagnostic?: string;
}): SpeechProviderContract[] {
  return SPEECH_PROVIDER_CATALOG.map((provider) => {
    const componentStatuses = provider.componentIds
      .map((id) => input.componentStates.get(id))
      .filter((item): item is { state: SpeechState; diagnosticCode?: string } => Boolean(item));
    const isLive = provider.id === input.liveTtsProviderId
      || provider.id === input.activeSingingProviderId;
    let state: SpeechState;
    let diagnosticCode: string | undefined;
    if (provider.id === input.activeSingingProviderId) {
      state = input.singingState;
      diagnosticCode = input.singingDiagnostic;
    } else if (provider.id === input.liveTtsProviderId) {
      // Provider 身份匹配不代表当前模型、硬件 benchmark 或 Sidecar 已可交付。
      // 直接复用 Runtime 的联合门禁，避免能力矩阵把阻塞误报成 ready。
      state = input.liveTtsState;
      diagnosticCode = input.liveTtsDiagnostic;
    } else if (componentStatuses.some((item) => item.state === 'error')) {
      state = 'error';
      diagnosticCode = componentStatuses.find((item) => item.state === 'error')?.diagnosticCode;
    } else if (componentStatuses.some((item) => item.state === 'blocked')) {
      state = 'blocked';
      diagnosticCode = componentStatuses.find((item) => item.state === 'blocked')?.diagnosticCode;
    } else {
      state = 'optional_missing';
      diagnosticCode = provider.diagnosticCode || componentStatuses.find((item) => item.diagnosticCode)?.diagnosticCode;
    }
    return {
      id: provider.id,
      displayName: provider.displayName,
      state,
      enabled: isLive && state === 'ready',
      experimental: provider.experimental,
      license: provider.license,
      capabilities: [...provider.capabilities],
      ...(diagnosticCode ? { diagnosticCode } : {}),
    };
  });
}
