import type { Detail, Language } from "./config";

export function buildTranslatorPrompt(
  language: Language,
  detail: Detail,
  agentContext?: string,
  memoryNote?: string
): string {
  const ctx = agentContext?.trim();
  const memory = memoryNote?.trim();

  const ctxBlock = ctx
    ? language === "en"
      ? `\nFocus / constraints from the agent: ${ctx}\n`
      : `\nAgent 侧关注点或约束：${ctx}\n`
    : "";

  const memoryBlock = memory
    ? language === "en"
      ? `\nKnown memory for this exact image: ${memory}\n`
      : `\n这张图片的已知记忆：${memory}\n`
    : "";

  const zh: Record<Detail, string> = {
    brief:
      "你是图片到文本的翻译器，供其他 Agent 当作上下文使用。用 2 到 4 句中文客观描述图中可见内容，包括主体、环境和清晰可读的文字。不要寒暄，不要说“这张图片”，不要编造看不清的细节。",
    standard:
      "你是图片到文本的翻译器。用一段中文客观说明画面主体、次要元素、布局或大致方位，以及清晰可读的文字。避免主观评价和臆测。",
    rich:
      "你是图片到文本的翻译器。用简短结构化中文输出，可用小标题或换行：可见主体；环境与背景；界面、控件或文字；整体场景类型。只写可见事实，不确定时写“不清楚”。",
  };

  const en: Record<Detail, string> = {
    brief:
      "You translate images into text for downstream agents. In 2 to 4 short sentences, objectively describe what is visible, including the subject, setting, and any clearly readable text. No greetings, no guessing.",
    standard:
      "You translate images into text for agents. In one concise paragraph, state the main subject, secondary elements, layout or rough positions, and any readable text verbatim. No subjective opinions.",
    rich:
      "You translate images into text for agents. Output short structured English with headings or line breaks: visible subject; environment and background; UI or text if any; scene type. Only visible facts. Say unclear when unsure.",
  };

  const table = language === "en" ? en : zh;
  return `${table[detail] ?? table.standard}${ctxBlock}${memoryBlock}`;
}
