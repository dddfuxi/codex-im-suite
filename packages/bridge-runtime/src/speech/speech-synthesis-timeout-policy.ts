export interface SpeechSynthesisTimingEvidence {
  warmSynthesisMs?: number;
  outputDurationMs?: number;
  realTimeFactor?: number;
}

const MAX_SYNTHESIS_TIMEOUT_MS = 10 * 60_000;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 使用语言无关的可见文本单位估算最终语音时长。中文按单字计，拉丁文本按词计，
 * 标点只增加很小停顿；该估算只用于超时保护，不参与模型选择或生成内容。
 */
export function estimateSpeechDurationMs(text: string): number {
  const normalized = text.normalize('NFKC').trim();
  if (!normalized) return 1_000;
  const cjkUnits = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length || 0;
  const withoutCjk = normalized.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ');
  const wordUnits = withoutCjk.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length || 0;
  const pauseUnits = normalized.match(/[，。！？；：,.!?;:\n]/gu)?.length || 0;
  return Math.max(1_000, (cjkUnits * 260) + (wordUnits * 380) + (pauseUnits * 120));
}

/**
 * TTS 的模型生成时限与普通媒体/ASR 请求时限分离。优先使用同模型、同版本、
 * 同硬件 benchmark 预测耗时；缺少 benchmark 时使用受控合成上限，避免首次
 * 高质量模型生成仍被旧的短请求时限误杀。
 */
export function resolveSpeechSynthesisTimeoutMs(input: {
  text: string;
  requestTimeoutMs: number;
  synthesisTimeoutMs: number;
  startupTimeoutMs: number;
  benchmark?: SpeechSynthesisTimingEvidence | null;
}): number {
  const configuredCap = Math.min(
    MAX_SYNTHESIS_TIMEOUT_MS,
    Math.max(1_000, Math.floor(input.synthesisTimeoutMs)),
  );
  const requestFloor = Math.min(configuredCap, Math.max(1_000, Math.floor(input.requestTimeoutMs)));
  const estimatedDurationMs = estimateSpeechDurationMs(input.text);
  const candidates: number[] = [];
  const benchmark = input.benchmark;

  if (finitePositive(benchmark?.realTimeFactor)) {
    candidates.push(estimatedDurationMs * benchmark.realTimeFactor);
  }
  if (finitePositive(benchmark?.warmSynthesisMs)) {
    candidates.push(benchmark.warmSynthesisMs);
    if (finitePositive(benchmark?.outputDurationMs)) {
      candidates.push(benchmark.warmSynthesisMs * Math.max(1, estimatedDurationMs / benchmark.outputDurationMs));
    }
  }

  if (candidates.length === 0) return configuredCap;
  const predictedMs = Math.max(...candidates);
  const readinessMarginMs = Math.max(5_000, Math.floor(input.startupTimeoutMs));
  return Math.min(
    configuredCap,
    Math.max(requestFloor, Math.ceil((predictedMs * 1.35) + readinessMarginMs)),
  );
}
