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
