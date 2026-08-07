import type { FeishuDocumentMemoryInput } from '../../../feishu-document-memory.js';
import { isGenericFeishuDocumentTitle } from './document-request-policy.js';

export interface FeishuCreatedDocument {
  documentId?: string;
  title: string;
  url: string;
}

export interface FeishuDocumentCreationPlan {
  markdown: string;
  createOptions: {
    title: string | undefined;
    ownerUserId: string | undefined;
  };
  recordContext: Omit<FeishuDocumentMemoryInput, 'title' | 'url' | 'documentId'>;
}

export type FeishuDocumentCreationDecision =
  | { allowed: true; markdown: string }
  | { allowed: false; reason: string };

export type FeishuDocumentGuideSyncPlan =
  | {
    mode: 'replace';
    documentId: string;
    options: { title: '飞书文档导览'; ownerUserId: string | undefined };
  }
  | {
    mode: 'create';
    options: { title: '飞书文档导览'; ownerUserId: string | undefined };
  };

export interface FeishuDocumentGuideMeta {
  documentId?: string;
  title: string;
  url: string;
  updatedAt: string;
}

export function buildFeishuDocumentCreationPlan(input: {
  markdown: string;
  requestedTitle?: string;
  ownerUserId?: string;
  chatId: string;
  requesterId?: string;
  workspace?: string;
  sourceText?: string;
}): FeishuDocumentCreationPlan {
  const requestedTitle = input.requestedTitle?.trim() || '';
  return {
    markdown: input.markdown,
    createOptions: {
      title: requestedTitle && !isGenericFeishuDocumentTitle(requestedTitle)
        ? requestedTitle
        : undefined,
      ownerUserId: input.ownerUserId?.trim() || undefined,
    },
    recordContext: {
      chatId: input.chatId,
      requesterId: input.requesterId,
      workspace: input.workspace,
      sourceText: input.sourceText,
      markdown: input.markdown,
    },
  };
}

/**
 * 文档创建属于真实外部写入，不能把 Provider/MCP 的诊断错误或空壳文本
 * 当作文档正文继续落库。内部“整理已有材料”链还要求完整 Markdown 标题，
 * 从而让 response-only 协议异常在写入前失败关闭。
 */
export function decideFeishuDocumentCreation(input: {
  markdown: string;
  providerHasError?: boolean;
  unexpectedToolUse?: boolean;
  requireHeading?: boolean;
}): FeishuDocumentCreationDecision {
  if (input.providerHasError) {
    return { allowed: false, reason: '正文生成失败，未创建文档。' };
  }
  if (input.unexpectedToolUse) {
    return { allowed: false, reason: '内部正文整理错误触发了工具执行，未创建文档。' };
  }

  const markdown = (input.markdown || '').replace(/^\uFEFF/u, '').trim();
  if (!markdown) {
    return { allowed: false, reason: '没有生成可写入的 Markdown 正文。' };
  }

  const firstLine = markdown.split(/\r?\n/u).find((line) => line.trim())?.trim() || '';
  const diagnosticOnly = /^(?:未完成|执行失败|失败|error|failed)\b/iu.test(firstLine)
    || /^MCP\s+tool\b.{0,160}\b(?:reported\s+failure|failed|error)\b/iu.test(firstLine)
    || /^(?:tool|工具)\b.{0,160}\b(?:reported\s+failure|执行失败|调用失败|failed|error)\b/iu.test(firstLine);
  if (diagnosticOnly) {
    return { allowed: false, reason: '正文只包含工具失败诊断，未创建文档。' };
  }
  if (input.requireHeading && !/^#\s+\S/u.test(firstLine)) {
    return { allowed: false, reason: '正文整理未返回完整的 Markdown 文档结构。' };
  }

  return { allowed: true, markdown };
}

export function buildFeishuDocumentRecordInput(
  plan: FeishuDocumentCreationPlan,
  document: FeishuCreatedDocument,
): FeishuDocumentMemoryInput {
  return {
    documentId: document.documentId,
    title: document.title,
    url: document.url,
    ...plan.recordContext,
  };
}

export function buildFeishuDocumentGuideSyncPlan(input: {
  configuredDocumentId?: string;
  storedDocumentId?: string;
  ownerUserId?: string;
}): FeishuDocumentGuideSyncPlan {
  const documentId = input.configuredDocumentId?.trim()
    || input.storedDocumentId?.trim()
    || '';
  const options = {
    title: '飞书文档导览' as const,
    ownerUserId: input.ownerUserId?.trim() || undefined,
  };
  return documentId
    ? { mode: 'replace', documentId, options }
    : { mode: 'create', options };
}

export function buildFeishuDocumentGuideMeta(
  plan: FeishuDocumentGuideSyncPlan,
  document: FeishuCreatedDocument,
  updatedAt: string,
): FeishuDocumentGuideMeta {
  return {
    documentId: document.documentId || (plan.mode === 'replace' ? plan.documentId : undefined),
    title: document.title,
    url: document.url,
    updatedAt,
  };
}

export function buildFeishuDocumentSuccessMessage(
  document: Pick<FeishuCreatedDocument, 'title' | 'url'>,
  guide?: Pick<FeishuCreatedDocument, 'title' | 'url'> | null,
): string {
  const base = `已生成飞书文档《${document.title}》\n${document.url}`;
  return guide ? `${base}\n\n文档导览已更新：${guide.url}` : base;
}

export function buildFeishuDocumentFailureMessage(error: unknown): string {
  const rawDetail = error instanceof Error
    ? error.message.trim()
    : typeof error === 'string'
      ? error.trim()
      : '';
  const detail = rawDetail
    .replace(/\b(access[_-]?token|refresh[_-]?token|app[_-]?secret|authorization|device[_-]?code)\s*[:=]\s*[^\s"']+/giu, '$1=[REDACTED]')
    .replace(/\b[A-Za-z]:\\[^\s"'<>|?*]+/gu, '[本地路径]')
    .slice(0, 500)
    .trim();
  return `飞书文档创建失败：${detail || '未知错误'}`;
}
