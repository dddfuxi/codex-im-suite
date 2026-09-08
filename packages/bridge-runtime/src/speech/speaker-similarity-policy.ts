/**
 * 说话人相似度使用 Qwen Base 自带 speaker encoder 的余弦相似度。
 * 阈值由 Runtime 单点声明并随请求传入 Sidecar，避免 Node/Python 各写一套。
 */
export const DEFAULT_SPEAKER_SIMILARITY_THRESHOLD = 0.72;

export function validSpeakerSimilarity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

export function speakerSimilarityPassed(value: unknown, threshold = DEFAULT_SPEAKER_SIMILARITY_THRESHOLD): boolean {
  return validSpeakerSimilarity(value)
    && validSpeakerSimilarity(threshold)
    && threshold >= 0
    && value >= threshold;
}

/**
 * 音色身份验收与模型性能验收必须分开：高质量模型即使生成较慢，只要真实
 * 相似度达到阈值，参考音色本身仍应被识别为已验收；速度问题继续由模型
 * benchmark.state / diagnosticCode 单独展示和限制。
 */
export function speakerSimilarityAcceptanceRecorded(input: {
  speakerSimilarity?: unknown;
  speakerSimilarityThreshold?: unknown;
  speakerSimilarityPassed?: unknown;
} | null | undefined): boolean {
  return input?.speakerSimilarityPassed === true
    && validSpeakerSimilarity(input.speakerSimilarityThreshold)
    && input.speakerSimilarityThreshold >= 0
    && speakerSimilarityPassed(input.speakerSimilarity, input.speakerSimilarityThreshold);
}
