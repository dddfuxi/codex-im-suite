export const STICKER_ANNOTATION_FENCE = 'cti-sticker-annotation';
export const STICKER_CANDIDATE_ANALYSIS_FENCE = 'cti-sticker-candidate-analysis';
export const STICKER_CANDIDATE_AUTO_SEND_MIN_CONFIDENCE = 0.45;

export interface StickerAnnotationPayload {
  fileKey: string;
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  avoidWhen?: string;
  aliases?: string[];
  examples?: string[];
  annotationConfidence?: number;
}

export interface StickerCandidateAnalysisResult {
  annotations: StickerAnnotationPayload[];
  selectedFileKey?: string;
  /** 模型是否尝试输出隐藏分析协议；即使协议无效也要阻止弱证据兜底。 */
  hasAnalysisBlock: boolean;
  text: string;
}

export function buildStickerChatPrompt(rawText: string, hasVisualReference: boolean): string {
  const text = rawText.trim();
  return [
    text || '用户发送了一个飞书表情包。',
    '',
    '这是一条轻量聊天消息。请把表情包当作聊天语气信号来理解，再像普通聊天一样简短自然地回应。',
    hasVisualReference
      ? '可以根据表情包画面判断情绪、态度或玩笑语气，但最终回复要直接接话，不要写成“图片里是……”的说明报告。'
      : '如果没有可用图片或已学习语义，只能根据上下文轻量回应，不要凭 file_key 猜具体图案。',
    '只有用户明确要求解释表情包时，才展开说明图案、文字或含义。',
  ].join('\n');
}

export function isExplicitStickerSendRequest(text: string): boolean {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (!normalized || normalized.length > 80) return false;
  if (/(?:不要|别|不用|禁止|别发|不要发)(?:.*?)(?:表情包|表情|sticker|贴纸)/iu.test(normalized)) return false;
  if (/(?:为什么|为何|原因|问题|失败|不能|不会|识别|解释|含义|意思)/iu.test(normalized)) return false;
  return /(?:表情包|表情|sticker|贴纸)/iu.test(normalized)
    && /(?:发|发送|回|回复|来|整|丢|贴|用|给|send|reply|post)/iu.test(normalized);
}

export function isGenericSingleStickerSendRequest(text: string): boolean {
  if (!isExplicitStickerSendRequest(text)) return false;
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (/(?:两|二|2|几|多)(?:个|张)?(?:表情包|表情|sticker|贴纸)/iu.test(normalized)) return false;
  if (/(?:随便|随机)/iu.test(normalized)) return true;
  return /^(?:(?:请|帮我|给我|来|发|回|回复|整|丢|贴|用|给))*(?:一|1)?(?:个|张)?(?:表情包|表情|sticker|贴纸)(?:吧|呀|啊|呗|喽|嘛|呢|了)?$/iu.test(normalized);
}

function hasLeadingExpressionHint(text: string): boolean {
  return /^\s*\[[^\]\r\n]{1,40}\]/u.test(text);
}

function isLightweightStickerFallbackAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 120 || hasLeadingExpressionHint(trimmed)) return false;
  return !/```|<[^>]+>|cti-|tool_|```json|^\s*[#>|-]\s/mu.test(trimmed);
}

export function stripLeadingFeishuStickerHint(text: string): string {
  return text.replace(/^\s*\[表情包(?::[^\]\r\n]{1,180})?\]\s*/u, '').trimStart();
}

export function hasLeadingFeishuStickerHint(text: string): boolean {
  return /^\s*\[表情包(?::[^\]\r\n]{1,180})?\]/u.test(text || '');
}

export function suppressFeishuStickerHintForInboundStickerReply(text: string): string {
  if (!hasLeadingFeishuStickerHint(text)) return text;
  return stripLeadingFeishuStickerHint(text) || '收到这个表情包了。';
}

function isStickerSendPlaceholderText(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[✅✔️☑️~～!！。.\s]+/gu, '').trim();
  if (!normalized || normalized.length > 40) return false;
  if (/(?:不乱发|不确定|看不清|没看清|不可读|没有可靠|不合适|不适合|不能|无法|不要|别发|不发)/u.test(normalized)) return false;
  return /(?:给你(?:来)?一个|发(?:你)?一个|丢一个|上一个|贴一个|安排|来啦|来了|好呀|可以)/u.test(normalized);
}

/**
 * 判断贴纸旁边的文字是否只是重复“已经发表情”这一动作。
 * 这类文字可以在贴纸成功投递后省略，避免出现“表情包已发送/给你一个”式机械回复。
 */
export function isRedundantStickerCompanionText(text: string): boolean {
  const normalized = String(text || '')
    .normalize('NFKC')
    .replace(/^\s*(?:✅|✔|☑|❌|×)\s*$/gmu, '')
    .replace(/[~～!！。.,，\s]+/gu, '')
    .trim();
  if (!normalized) return true;
  if (normalized.length > 24) return false;
  return /^(?:给你(?:来)?一个|发(?:你)?一个|丢一个|上一个|贴一个|安排|来啦|来了|来咯|好呀|好嘞|可以|收到|懂了|哈哈|嘿嘿|喏|拿去|表情包已发送|已回应)$/u.test(normalized);
}

function isCasualStickerOnlyContext(text: string): boolean {
  const normalized = String(text || '').normalize('NFKC').replace(/\s+/g, '').trim();
  if (!normalized || normalized.length > 48) return false;
  if (/(?:怎么|如何|为什么|为何|能否|是否|哪里|多少|谁|什么|查|读取|写入|修改|修复|生成|创建|删除|同步|重启|运行|执行|处理|分析|总结|文件|代码|项目|任务|bug|报错|错误|mcp|unity|blender|文档|表格|日程|会议|私发|发送给)/iu.test(normalized)) {
    return false;
  }
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}\p{S}]+$/u.test(normalized)) return true;
  return /^(?:哈+|哈哈哈*|嘿嘿|收到|好的|好呀|好嘞|行|可以|嗯+|哦+|嗨|你好|早呀|早安|晚安|谢谢|谢啦|辛苦|牛|厉害|真棒|笑死|离谱|可爱|爱你|拜拜|在吗|干嘛|来啦|冲呀|加油)(?:呀|啊|啦|咯|呢|嘛|哇|哦|噢|哈|～|~|!|！)*$/iu.test(normalized);
}

/**
 * 贴纸可以独立完成回复，但不能取代需要信息、执行结果或错误说明的正文。
 * 明确“发个表情包”请求允许省略动作复述；自主贴纸只在轻量社交语境中成立。
 */
export function shouldUseStickerOnlyReply(
  userText: string,
  companionText: string,
  explicitRequest: boolean,
): boolean {
  if (!isRedundantStickerCompanionText(companionText)) return false;
  return explicitRequest || isCasualStickerOnlyContext(userText);
}

export function addFeishuStickerHintForExplicitRequest(
  userText: string,
  answerText: string,
  selectedFileKey?: string,
  options?: { allowBareFallback?: boolean },
): string {
  if (!isExplicitStickerSendRequest(userText)) return answerText;
  const selected = selectedFileKey?.trim() || '';
  if (selected && /^[A-Za-z0-9_-]{3,160}$/.test(selected)) {
    return `[表情包:${selected}] ${stripLeadingFeishuStickerHint(answerText) || '给你一个。'}`;
  }
  if (options?.allowBareFallback === false) {
    const visibleText = stripLeadingFeishuStickerHint(answerText);
    if (!visibleText || (hasLeadingFeishuStickerHint(answerText) && isStickerSendPlaceholderText(visibleText))) {
      return '这个表情包候选还没有可靠语义，我先不乱发。';
    }
    return visibleText;
  }
  if (hasLeadingExpressionHint(answerText) || !isLightweightStickerFallbackAnswer(answerText)) return answerText;
  return `[表情包] ${answerText.trim()}`;
}

export function buildStickerAnnotationSystemPrompt(fileKey?: string): string {
  const expectedFileKey = fileKey?.trim() || '';
  return [
    'Feishu sticker semantic annotation:',
    '- If this turn includes a Feishu sticker image attachment, answer the user naturally first.',
    '- This annotation turn is not a request to send a sticker. Do not start the visible reply with `[表情包]`, `[表情包:file_key]`, or any sticker action unless the current user explicitly asks you to send a sticker.',
    '- Do not invoke image generation, imagegen, asset creation, or shortcut sticker sending for this annotation turn; only inspect the attached existing sticker image.',
    `- Then append exactly one fenced \`${STICKER_ANNOTATION_FENCE}\` JSON block so the bridge can cache the sticker meaning for future semantic selection.`,
    expectedFileKey ? `- The JSON fileKey must be exactly "${expectedFileKey}".` : '- Use the current sticker fileKey from the user message.',
    '- JSON fields: fileKey, label, description, intent, tone, usage, aliases, confidence.',
    '- Keep label and aliases short. Use confidence from 0 to 1. If the image is unclear, use a low confidence and only include what is visible.',
    '- If the message includes a user-provided sticker meaning, treat it as an unverified claim. Inspect the image first; when the claim conflicts with visible text, character, tone, or context, annotate from the image facts instead of repeating the claim.',
    '- The fenced annotation block is machine-readable metadata and will be removed before sending the visible reply.',
  ].join('\n');
}

export function buildStickerAnnotationFallbackPrompt(fileKey: string): string {
  return [
    'Generate only machine-readable Feishu sticker semantic metadata for the attached existing sticker image.',
    `Current sticker fileKey: ${fileKey}`,
    `Output exactly one fenced \`${STICKER_ANNOTATION_FENCE}\` JSON block and no other text.`,
    'The JSON must describe visible image facts: fileKey, label, description, intent, tone, usage, aliases, confidence.',
    'Do not send, choose, create, search, or generate any sticker/image. Do not use `[表情包]` action hints.',
    'If the image is unreadable, still use the same JSON shape with low confidence and only concrete visible facts.',
  ].join('\n');
}

export function buildStickerCandidateAnalysisSystemPrompt(attachedFileKeys: string[], requestText: string): string {
  const allowed = attachedFileKeys.map((item) => item.trim()).filter(Boolean);
  if (allowed.length === 0) return '';
  return [
    'Feishu sticker candidate vision analysis:',
    '- This turn includes sticker library candidate images attached by the bridge. Inspect the actual images before deciding.',
    '- This is an existing-sticker analysis turn, not an asset-creation task: do not read or invoke skills, do not call imagegen or any image-generation tool, and do not create, search for, or attach new image files.',
    `- After the visible reply, append exactly one fenced \`${STICKER_CANDIDATE_ANALYSIS_FENCE}\` JSON block. The bridge removes this block before sending.`,
    `- Allowed fileKey values for this turn: ${allowed.join(', ')}`,
    requestText.trim() ? `- User sticker request: ${requestText.trim()}` : '',
    '- JSON schema: { "selectedFileKey": string|null, "annotations": [{ "fileKey": string, "label": string, "description": string, "intent": string, "tone": string, "usage": string, "avoidWhen": string, "aliases": string[], "confidence": number }] }.',
    '- Include an annotation for every candidate you can understand from the image. Keep labels short and use confidence from 0 to 1.',
    `- A selected sticker is auto-sendable only when its annotation includes confidence >= ${STICKER_CANDIDATE_AUTO_SEND_MIN_CONFIDENCE} and a specific visible meaning/tone/usage, not just generic words like “sticker” or “表情包”; missing confidence or generic semantics means evidence-only and selectedFileKey should be null.`,
    '- For generic requests such as “随便发一个表情包”, choose selectedFileKey only after you can describe the selected image meaning. Do not leave it blank merely because old metadata is missing.',
    '- For specific tone requests, choose selectedFileKey only when the image meaning matches the requested tone or scene. If no candidate is suitable or readable, use null and reply with text or a reaction instead.',
    '- Treat old aliases and user-provided explanations as retrieval hints, not visual facts.',
  ].filter(Boolean).join('\n');
}

export function stripStickerAnnotationProtocolArtifacts(text: string): string {
  return text
    .replace(new RegExp(String.raw`(?:^|\n)\s*\`\`\`${STICKER_ANNOTATION_FENCE}\s*\n[\s\S]*?\n\s*\`\`\``, 'gi'), '\n')
    .replace(new RegExp(String.raw`(?:^|\n)\s*\`\`\`${STICKER_CANDIDATE_ANALYSIS_FENCE}\s*\n[\s\S]*?\n\s*\`\`\``, 'gi'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripStickerCandidateAnalysisProtocolArtifacts(text: string): string {
  return text
    .replace(new RegExp(String.raw`(?:^|\n)\s*\`\`\`${STICKER_CANDIDATE_ANALYSIS_FENCE}\s*\n[\s\S]*?\n\s*\`\`\``, 'gi'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseStickerAnnotationObject(candidate: unknown, expectedFileKey: string): StickerAnnotationPayload | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const raw = candidate as Record<string, unknown>;
  const fileKey = typeof raw.fileKey === 'string' ? raw.fileKey.trim() : '';
  if (!fileKey || fileKey !== expectedFileKey) return null;
  const cleanText = (value: unknown, maxLength: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    return text && text.length <= maxLength ? text : undefined;
  };
  const cleanList = (value: unknown, maxItems: number, maxLength: number): string[] => (
    Array.isArray(value) ? value : []
  ).map((item) => cleanText(item, maxLength)).filter((item): item is string => Boolean(item)).slice(0, maxItems);
  const annotation: StickerAnnotationPayload = { fileKey };
  const label = cleanText(raw.label, 32);
  const description = cleanText(raw.description, 180);
  const intent = cleanText(raw.intent, 160);
  const tone = cleanText(raw.tone, 80);
  const usage = cleanText(raw.usage, 180);
  const avoidWhen = cleanText(raw.avoidWhen, 180);
  if (label) annotation.label = label;
  if (description) annotation.description = description;
  if (intent) annotation.intent = intent;
  if (tone) annotation.tone = tone;
  if (usage) annotation.usage = usage;
  if (avoidWhen) annotation.avoidWhen = avoidWhen;
  const aliases = cleanList(raw.aliases, 20, 32);
  const examples = cleanList(raw.examples, 8, 120);
  if (aliases.length > 0) annotation.aliases = aliases;
  if (examples.length > 0) annotation.examples = examples;
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : Number.isFinite(Number(raw.annotationConfidence))
      ? Math.max(0, Math.min(1, Number(raw.annotationConfidence)))
      : undefined;
  if (typeof confidence === 'number') annotation.annotationConfidence = confidence;
  if (!annotation.label && !annotation.description && !annotation.intent && !annotation.tone && !annotation.usage) return null;
  return annotation;
}

export function extractStickerAnnotationFromReply(
  text: string,
  expectedFileKey?: string,
): { annotation: StickerAnnotationPayload | null; text: string } {
  const fileKey = expectedFileKey?.trim();
  if (!fileKey) return { annotation: null, text };
  const fencePattern = new RegExp(String.raw`(?:^|\n)\s*\`\`\`${STICKER_ANNOTATION_FENCE}\s*\n([\s\S]*?)\n\s*\`\`\``, 'gi');
  let annotation: StickerAnnotationPayload | null = null;
  for (const match of text.matchAll(fencePattern)) {
    try {
      annotation = parseStickerAnnotationObject(JSON.parse(match[1].trim()), fileKey) || annotation;
    } catch {
      // 协议错误不能破坏可见回复。
    }
  }
  return { annotation, text: stripStickerAnnotationProtocolArtifacts(text) };
}

function hasSpecificStickerSemanticText(value: string): boolean {
  const compact = value.normalize('NFKC').toLowerCase()
    .replace(/[\s，,。.;；:：、"'“”‘’()[\]{}<>《》【】!！?？~～_-]+/gu, '')
    .replace(/(?:飞书|表情包|表情|sticker|贴纸|图片|图像|动图|一张|一个|这个|那个|用于|用来|使用|发送|回复|回话|聊天|消息|默认|随便|普通|轻量|发个|发|给你|来一个|来)/gu, '')
    .trim();
  return compact.length >= 2;
}

function hasSpecificStickerAnnotation(annotation: StickerAnnotationPayload): boolean {
  return hasSpecificStickerSemanticText([
    annotation.label,
    annotation.description,
    annotation.intent,
    annotation.tone,
    annotation.usage,
    annotation.avoidWhen,
    ...(annotation.aliases || []),
    ...(annotation.examples || []),
  ].filter((item): item is string => Boolean(item?.trim())).join(' '));
}

function parseStickerCandidateAnalysisObject(
  candidate: unknown,
  allowedFileKeys: Set<string>,
): { annotations: StickerAnnotationPayload[]; selectedFileKey?: string } {
  if (!candidate || typeof candidate !== 'object' || allowedFileKeys.size === 0) return { annotations: [] };
  const raw = candidate as Record<string, unknown>;
  const annotations: StickerAnnotationPayload[] = [];
  const seen = new Set<string>();
  const getFileKey = (value: unknown): string => {
    if (!value || typeof value !== 'object') return '';
    const item = value as Record<string, unknown>;
    return typeof item.fileKey === 'string' ? item.fileKey.trim() : '';
  };
  const addAnnotation = (item: unknown) => {
    const fileKey = getFileKey(item);
    if (!fileKey || !allowedFileKeys.has(fileKey) || seen.has(fileKey)) return;
    const parsed = parseStickerAnnotationObject(item, fileKey);
    if (!parsed) return;
    annotations.push(parsed);
    seen.add(fileKey);
  };
  addAnnotation(raw);
  const selectedObject = raw.selected && typeof raw.selected === 'object'
    ? raw.selected
    : raw.selectedSticker && typeof raw.selectedSticker === 'object'
      ? raw.selectedSticker
      : null;
  addAnnotation(selectedObject);
  for (const item of Array.isArray(raw.annotations) ? raw.annotations : []) addAnnotation(item);
  for (const item of Array.isArray(raw.candidates) ? raw.candidates : []) addAnnotation(item);
  const selectedFileKey = typeof raw.selectedFileKey === 'string'
    ? raw.selectedFileKey.trim()
    : typeof raw.selected_file_key === 'string'
      ? raw.selected_file_key.trim()
      : getFileKey(selectedObject);
  const sendable = new Set(annotations.filter((item) => (
    typeof item.annotationConfidence === 'number'
    && item.annotationConfidence >= STICKER_CANDIDATE_AUTO_SEND_MIN_CONFIDENCE
    && hasSpecificStickerAnnotation(item)
  )).map((item) => item.fileKey));
  return {
    annotations,
    selectedFileKey: selectedFileKey && allowedFileKeys.has(selectedFileKey) && sendable.has(selectedFileKey)
      ? selectedFileKey
      : undefined,
  };
}

export function extractStickerCandidateAnalysisFromReply(
  text: string,
  allowedFileKeys: string[] = [],
): StickerCandidateAnalysisResult {
  const allowed = new Set(allowedFileKeys.map((item) => item.trim()).filter(Boolean));
  if (allowed.size === 0) return {
    annotations: [],
    hasAnalysisBlock: false,
    text: stripStickerCandidateAnalysisProtocolArtifacts(text),
  };
  const fencePattern = new RegExp(String.raw`(?:^|\n)\s*\`\`\`${STICKER_CANDIDATE_ANALYSIS_FENCE}\s*\n([\s\S]*?)\n\s*\`\`\``, 'gi');
  const annotations = new Map<string, StickerAnnotationPayload>();
  let selectedFileKey: string | undefined;
  let hasAnalysisBlock = false;
  for (const match of text.matchAll(fencePattern)) {
    hasAnalysisBlock = true;
    try {
      const parsed = parseStickerCandidateAnalysisObject(JSON.parse(match[1].trim()), allowed);
      for (const annotation of parsed.annotations) annotations.set(annotation.fileKey, annotation);
      if (parsed.selectedFileKey) selectedFileKey = parsed.selectedFileKey;
    } catch {
      // 协议错误不能破坏可见回复。
    }
  }
  return {
    annotations: [...annotations.values()],
    selectedFileKey,
    hasAnalysisBlock,
    text: stripStickerCandidateAnalysisProtocolArtifacts(text),
  };
}

export function resolveTurnScopedAttachedStickerSelection(
  userText: string,
  answerText: string,
  analysis: StickerCandidateAnalysisResult,
  attachedFileKeys: string[],
): string {
  if (!isGenericSingleStickerSendRequest(userText) || analysis.hasAnalysisBlock) return '';
  const allowed = new Set(attachedFileKeys.map((item) => item.trim()).filter(Boolean));
  if (allowed.size === 0) return '';
  const selected = new Set<string>();
  for (const match of answerText.matchAll(/\[表情包:([A-Za-z0-9_-]{3,160})\]/gu)) {
    const fileKey = (match[1] || '').trim();
    if (allowed.has(fileKey)) selected.add(fileKey);
  }
  return selected.size === 1 ? [...selected][0] : '';
}
