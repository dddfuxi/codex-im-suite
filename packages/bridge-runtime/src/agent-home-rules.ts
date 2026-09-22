export interface ManagedAgentHomeRuleInput {
  key: string;
  content: string;
  updatedAt: string;
}

export function normalizeManagedAgentHomeRuleKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80) || 'general';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function renderRule(input: ManagedAgentHomeRuleInput, key: string): string {
  return [
    `<!-- cti-agent-home-rule:start key="${key}" updatedAt="${input.updatedAt}" -->`,
    `### ${key}`,
    '',
    input.content.trim(),
    '<!-- cti-agent-home-rule:end -->',
  ].join('\n');
}

export function upsertManagedAgentHomeRule(original: string, input: ManagedAgentHomeRuleInput): string {
  const key = normalizeManagedAgentHomeRuleKey(input.key);
  const rule = renderRule(input, key);
  const existingRule = new RegExp(
    `<!-- cti-agent-home-rule:start key="${escapeRegex(key)}"[^>]* -->[\\s\\S]*?<!-- cti-agent-home-rule:end -->`,
    'u',
  );
  if (existingRule.test(original)) {
    return `${original.replace(existingRule, rule).trimEnd()}\n`;
  }

  const heading = '## Agent 自维护规则';
  const headingIndex = original.indexOf(heading);
  if (headingIndex < 0) {
    return `${original.trimEnd()}\n\n${heading}\n\n${rule}\n`;
  }
  const sectionContentStart = headingIndex + heading.length;
  const nextHeadingMatch = /\n## (?!#)/u.exec(original.slice(sectionContentStart));
  const insertAt = nextHeadingMatch ? sectionContentStart + nextHeadingMatch.index : original.length;
  return `${original.slice(0, insertAt).trimEnd()}\n\n${rule}\n\n${original.slice(insertAt).trimStart()}`.trimEnd() + '\n';
}
