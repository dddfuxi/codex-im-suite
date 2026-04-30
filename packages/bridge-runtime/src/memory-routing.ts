const EXPLICIT_RECALL_PATTERNS = [
  /你还记得/u,
  /还记得/u,
  /帮我(找|查|回忆|回溯)/u,
  /找(一下|出|回)?(上次|之前|以前|历史|记忆)/u,
  /查(一下|出)?(上次|之前|以前|历史|记忆)/u,
  /上次(记录|说的|提到的|那份|那个)/u,
  /之前(记录|说过|提到|让我记|让你记)/u,
  /再发我(一次|一下)?/u,
  /固定对应表/u,
  /记忆/u,
  /历史/u,
  /\bremember\b/i,
  /\brecall\b/i,
  /\bhistory\b/i,
  /\bprevious\b/i,
];

export function shouldRetrieveMemoryForPrompt(prompt: string): boolean {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldDirectAnswerFromMemory(_prompt: string): boolean {
  return false;
}
