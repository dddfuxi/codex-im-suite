import { archiveHumanReadableDocuments } from '../packages/bridge-runtime/src/human-document-governance.js';

const memoryRoot = process.env.CTI_MEMORY_ROOT?.trim();
const requested = JSON.parse(process.env.CTI_HUMAN_DOCS || '[]');
if (!memoryRoot) throw new Error('CTI_MEMORY_ROOT 未设置。');
if (!Array.isArray(requested) || requested.some((item) => typeof item !== 'string')) {
  throw new Error('CTI_HUMAN_DOCS 必须是相对 Markdown 路径数组。');
}

const result = archiveHumanReadableDocuments(memoryRoot, requested);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
