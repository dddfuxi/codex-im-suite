import path from 'node:path';

import type { ExecutionRequirementKind } from '../execution-requirement.js';
import type { FileAttachment } from '../host.js';
import type { DeliveryCandidatePayload } from './delivery-preparation.js';

export type InputAttachmentDeliveryPurpose =
  | 'inspect_input'
  | 'deliver_input'
  | 'produce_output'
  | 'unspecified';

export interface InputEvidenceDeliveryDecision {
  payload: DeliveryCandidatePayload;
  purpose: InputAttachmentDeliveryPurpose;
  filteredImages: string[];
  filteredFiles: string[];
}

const INPUT_MEDIA_OBJECT = String.raw`(?:(?:(?:这(?:一)?张|这(?:一)?个|该|当前|刚才(?:那)?(?:张|个)?|上(?:一)?条(?:里的)?|附件(?:里的)?|原始|原版|原)\s*)?(?:图|图片|图像|照片|截图|头像|表情包|文件|附件)|原图|原文件|它|(?:(?:this|that|the|current|original)\s+)?(?:image|picture|photo|screenshot|avatar|sticker|file|attachment)|it)`;
const DELIVERY_ACTION = String.raw`(?:发(?:送)?|转发|回传|返还|返回|展示|显示|呈现|贴(?:出来|上来)?|放(?:出来|上来)?|附上|附带|提供|分享|交付|递交|传(?:给)?|给(?:到)?|上传|下载|导出|保存|留存|拿到|取回|send|forward|return|show|display|present|attach|share|deliver|upload|download|save)`;
const OUTPUT_RECIPIENT = String.raw`(?:给我|发我|传我|让我|在这里|到这里|当前对话|当前聊天|回复里|消息里|to\s+me|here|in\s+(?:the\s+)?reply)`;

const DIRECT_OBJECT_DELIVERY_RE = new RegExp(
  String.raw`(?:把|将)?\s*${INPUT_MEDIA_OBJECT}.{0,18}${DELIVERY_ACTION}|${DELIVERY_ACTION}.{0,18}${INPUT_MEDIA_OBJECT}|${OUTPUT_RECIPIENT}.{0,12}${INPUT_MEDIA_OBJECT}|(?:我要|我需要|我想要|给我|让我看)\s*${INPUT_MEDIA_OBJECT}|(?:结果|回复|回答|消息).{0,12}(?:包含|带上|附上|附带|需要有|要有).{0,12}${INPUT_MEDIA_OBJECT}|(?:以|用)\s*${INPUT_MEDIA_OBJECT}\s*(?:形式)?(?:回复|回答|返回)`,
  'iu',
);
const TRANSFORM_OUTPUT_RE = /(?:生成|创建|编辑|修改|修图|标注|圈出|圈起来|裁剪|压缩|转换|合成|抠图|遮挡|打码|重绘|重建|加字|去除|替换|增强|放大|缩小|旋转|翻转|generate|create|edit|modify|annotate|crop|compress|convert|compose|redraw|enhance|resize|rotate)/iu;
const INSPECTION_RE = /(?:识别|描述|分析|判断|解释|读取|提取|检查|诊断|看看|看一下|看一眼|看下|是什么|有什么|谁|recognize|describe|analy[sz]e|identify|inspect|explain|read|extract|what|who)/iu;
const DELIVERY_NEGATION_RE = /(?:不要|不用|无需|无须|别|禁止|不必|不需要|不想|不希望|不要再|不是|并非|没(?:有)?要求|未要求|do\s+not|don't|dont|without)[^，,。；;！？!?\n]{0,18}(?:发|发送|转发|回传|返还|返回|展示|显示|贴|放|附上|提供|分享|传|上传|下载|导出|保存|send|forward|return|show|display|attach|share|deliver|upload|download|save)/iu;
const TRANSFORM_NEGATION_RE = /(?:不要|不用|无需|无须|别|禁止|不必|不需要|不想|不希望|不是|并非|do\s+not|don't|dont|without)[^，,。；;！？!?\n]{0,18}(?:生成|创建|编辑|修改|修图|标注|圈出|裁剪|压缩|转换|合成|抠图|遮挡|打码|重绘|重建|加字|去除|替换|增强|放大|缩小|旋转|翻转|generate|create|edit|modify|annotate|crop|compress|convert|compose|redraw|enhance|resize|rotate)/iu;

function normalizeIntentText(text: string): string {
  return (text || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function splitIntentClauses(text: string): string[] {
  return text.split(/[，,。；;！？!?\n]+/u).map((clause) => clause.trim()).filter(Boolean);
}

function hasAffirmativeTransformPurpose(text: string): boolean {
  return splitIntentClauses(text).some((clause) => (
    TRANSFORM_OUTPUT_RE.test(clause) && !TRANSFORM_NEGATION_RE.test(clause)
  ));
}

function hasAffirmativeInputDeliveryPurpose(text: string): boolean {
  return splitIntentClauses(text).some((clause) => (
    DIRECT_OBJECT_DELIVERY_RE.test(clause) && !DELIVERY_NEGATION_RE.test(clause)
  ));
}

/**
 * 识别当前请求的结果目的，而不是把某个文件名、头像场景或单一措辞写死。
 * “输入供识别”与“把同一输入作为结果交付”是两个独立意图；后者必须有
 * 面向用户的交付目的，生成/编辑则属于新的输出产物。
 */
export function classifyInputAttachmentDeliveryPurpose(userText: string): InputAttachmentDeliveryPurpose {
  const text = normalizeIntentText(userText);
  if (!text) return 'unspecified';
  if (hasAffirmativeTransformPurpose(text)) return 'produce_output';
  if (hasAffirmativeInputDeliveryPurpose(text)) return 'deliver_input';
  if (INSPECTION_RE.test(text)) return 'inspect_input';
  return 'unspecified';
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.normalize(filePath.trim()).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function normalizeComparableName(name: string): string {
  const normalized = path.basename(name.trim());
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function buildInputAttachmentIdentity(attachments: readonly FileAttachment[]): {
  paths: Set<string>;
  uniqueNames: Set<string>;
} {
  const paths = new Set<string>();
  const nameCounts = new Map<string, number>();
  for (const attachment of attachments) {
    if (attachment.filePath?.trim()) paths.add(normalizeComparablePath(attachment.filePath));
    const name = normalizeComparableName(attachment.name || attachment.filePath || '');
    if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  return {
    paths,
    uniqueNames: new Set([...nameCounts.entries()].filter(([, count]) => count === 1).map(([name]) => name)),
  };
}

function filterInputAttachmentPaths(
  candidates: readonly string[],
  identity: ReturnType<typeof buildInputAttachmentIdentity>,
  allowWeakNameMatch: boolean,
): { kept: string[]; filtered: string[] } {
  const kept: string[] = [];
  const filtered: string[] = [];
  for (const candidate of candidates) {
    const exactInputPath = identity.paths.has(normalizeComparablePath(candidate));
    const uniqueInputName = identity.uniqueNames.has(normalizeComparableName(candidate));
    if (exactInputPath || (allowWeakNameMatch && uniqueInputName)) {
      filtered.push(candidate);
    } else {
      kept.push(candidate);
    }
  }
  return { kept, filtered };
}

/**
 * Provider 输入附件默认只是证据，不能因为模型把同一路径写进 cti-final 就自动
 * 回流给用户。只有当前请求的结果目的确实要求交付原输入时才放行；新生成或编辑
 * 的不同路径仍正常发送。
 */
export function enforceInputEvidenceDeliveryBoundary(input: {
  payload: DeliveryCandidatePayload;
  userText: string;
  inputAttachments?: readonly FileAttachment[];
  executionRequirementKind?: ExecutionRequirementKind;
}): InputEvidenceDeliveryDecision {
  const attachments = input.inputAttachments || [];
  const purpose = classifyInputAttachmentDeliveryPurpose(input.userText);
  if (attachments.length === 0 || purpose === 'deliver_input') {
    return {
      payload: input.payload,
      purpose,
      filteredImages: [],
      filteredFiles: [],
    };
  }

  const identity = buildInputAttachmentIdentity(attachments);
  // 只读输入回合允许用唯一 basename 识别模型的相对路径别名；生成/编辑回合
  // 仅按完整路径去重，避免误删恰好同名的新产物。
  const allowWeakNameMatch = purpose === 'inspect_input'
    || input.executionRequirementKind === 'input_evidence_required';
  const images = filterInputAttachmentPaths(input.payload.images, identity, allowWeakNameMatch);
  const files = filterInputAttachmentPaths(input.payload.files, identity, allowWeakNameMatch);
  const cardHero = input.payload.cardHero
    && images.kept.some((imagePath) => normalizeComparablePath(imagePath) === normalizeComparablePath(input.payload.cardHero!.imagePath))
    ? input.payload.cardHero
    : undefined;
  return {
    payload: {
      ...input.payload,
      images: images.kept,
      files: files.kept,
      cardHero,
    },
    purpose,
    filteredImages: images.filtered,
    filteredFiles: files.filtered,
  };
}
