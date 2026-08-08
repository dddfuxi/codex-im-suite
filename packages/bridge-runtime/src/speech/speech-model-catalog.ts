import type { SpeechModelCapability } from '@codex-im-suite/contracts/speech';

export type SpeechModelVariant = 'custom_voice' | 'base' | 'sft';

export interface SpeechModelCatalogEntry {
  id: string;
  displayName: string;
  providerId: string;
  providerDisplayName: string;
  variant: SpeechModelVariant;
  sizeLabel: string;
  componentId: string;
  /** Sidecar 只能把这个官方身份与本地受管目录核对，禁止在线解析或下载。 */
  upstreamModelId: string;
  capabilities: SpeechModelCapability[];
  defaultVoiceProfileId: string;
}

export interface SpeechPresetVoiceCatalogEntry {
  id: string;
  displayName: string;
  providerId: string;
  speakerId: string;
  nativeLanguage: string;
  license: string;
  sourceLabel: string;
  compatibleTtsModelIds: string[];
}

export const DEFAULT_TTS_PROVIDER_ID = 'qwen3_tts';
export const DEFAULT_TTS_MODEL_ID = 'qwen3-tts-12hz-1.7b-custom-voice';
export const LOW_VRAM_TTS_MODEL_ID = 'qwen3-tts-12hz-0.6b-custom-voice';
export const DEFAULT_TTS_VOICE_PROFILE_ID = 'qwen3.serena';
export const DEFAULT_TONE_POLICY_ID = 'adaptive_natural';

const qwenCustomModels = [
  {
    id: DEFAULT_TTS_MODEL_ID,
    displayName: 'Qwen3-TTS 12Hz 1.7B CustomVoice',
    sizeLabel: '1.7B',
    upstreamModelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
  },
  {
    id: LOW_VRAM_TTS_MODEL_ID,
    displayName: 'Qwen3-TTS 12Hz 0.6B CustomVoice（低显存）',
    sizeLabel: '0.6B',
    upstreamModelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  },
] as const;

const qwenBaseModels = [
  {
    id: 'qwen3-tts-12hz-1.7b-base',
    displayName: 'Qwen3-TTS 12Hz 1.7B Base（音色复刻）',
    sizeLabel: '1.7B',
    upstreamModelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
  },
  {
    id: 'qwen3-tts-12hz-0.6b-base',
    displayName: 'Qwen3-TTS 12Hz 0.6B Base（低显存复刻）',
    sizeLabel: '0.6B',
    upstreamModelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
  },
] as const;

/**
 * Runtime 模型目录唯一事实源。新增模型只改 Catalog 与受管 manifest，
 * Core、C# 和 React 不复制模型名称、能力或兼容关系。
 */
export const SPEECH_MODEL_CATALOG: readonly SpeechModelCatalogEntry[] = [
  ...qwenCustomModels.map((item) => ({
    ...item,
    providerId: 'qwen3_tts',
    providerDisplayName: 'Qwen3-TTS',
    variant: 'custom_voice' as const,
    componentId: item.id,
    capabilities: ['preset_voice', 'instruction_control'] as SpeechModelCapability[],
    defaultVoiceProfileId: DEFAULT_TTS_VOICE_PROFILE_ID,
  })),
  ...qwenBaseModels.map((item) => ({
    ...item,
    providerId: 'qwen3_tts',
    providerDisplayName: 'Qwen3-TTS',
    variant: 'base' as const,
    componentId: item.id,
    capabilities: ['voice_clone'] as SpeechModelCapability[],
    defaultVoiceProfileId: '',
  })),
  {
    id: 'cosyvoice-300m-sft',
    displayName: 'CosyVoice 300M SFT（兼容旧配置）',
    providerId: 'cosyvoice',
    providerDisplayName: 'CosyVoice',
    variant: 'sft',
    sizeLabel: '300M',
    componentId: 'cosyvoice',
    upstreamModelId: 'FunAudioLLM/CosyVoice-300M-SFT',
    capabilities: ['preset_voice'],
    defaultVoiceProfileId: 'cosyvoice.sft.zh_female',
  },
] as const;

const qwenCustomModelIds = qwenCustomModels.map((item) => item.id);

export const SPEECH_PRESET_VOICE_CATALOG: readonly SpeechPresetVoiceCatalogEntry[] = [
  ['qwen3.vivian', 'Vivian · 明亮年轻女声', 'Vivian', '中文'],
  ['qwen3.serena', 'Serena · 温暖自然女声', 'Serena', '中文'],
  ['qwen3.uncle_fu', 'Uncle Fu · 醇厚成熟男声', 'Uncle_Fu', '中文'],
  ['qwen3.dylan', 'Dylan · 年轻北京男声', 'Dylan', '中文（北京）'],
  ['qwen3.eric', 'Eric · 活泼成都男声', 'Eric', '中文（四川）'],
  ['qwen3.ryan', 'Ryan · 节奏感英文男声', 'Ryan', '英语'],
  ['qwen3.aiden', 'Aiden · 阳光美式男声', 'Aiden', '英语'],
  ['qwen3.ono_anna', 'Ono Anna · 活泼日语女声', 'Ono_Anna', '日语'],
  ['qwen3.sohee', 'Sohee · 温暖韩语女声', 'Sohee', '韩语'],
].map(([id, displayName, speakerId, nativeLanguage]) => ({
  id,
  displayName,
  providerId: 'qwen3_tts',
  speakerId,
  nativeLanguage,
  license: 'Apache-2.0',
  sourceLabel: 'Qwen3-TTS 官方 CustomVoice',
  compatibleTtsModelIds: [...qwenCustomModelIds],
}));

export function findSpeechModel(modelId: string): SpeechModelCatalogEntry | undefined {
  return SPEECH_MODEL_CATALOG.find((item) => item.id === modelId);
}

export function listSpeechProviders(): Array<{ id: string; displayName: string }> {
  const providers = new Map<string, string>();
  for (const model of SPEECH_MODEL_CATALOG) providers.set(model.providerId, model.providerDisplayName);
  return [...providers].map(([id, displayName]) => ({ id, displayName }));
}

export function isVoiceCompatibleWithModel(input: {
  modelId: string;
  compatibleTtsModelIds: readonly string[];
}): boolean {
  return input.compatibleTtsModelIds.includes(input.modelId);
}

/** 语气策略由 Runtime 映射为固定、不可执行的模型指令，面板和模型都不能注入自由命令。 */
export function speechToneInstruction(policyId: string): string {
  if (policyId === 'neutral_stable') return '请使用稳定、清晰、中性的自然语气。';
  return '请使用亲切、自然、有适度情感起伏的语气，避免机械朗读和夸张表演。';
}
