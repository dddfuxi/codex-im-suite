import Anthropic from "@anthropic-ai/sdk";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";
import OpenAI from "openai";
import type { AppConfig, Detail, Language } from "./config";
import { buildTranslatorPrompt } from "./prompts";
import { parseImageInput, readPathImageAsBase64 } from "./imageInput";
import { callCustomHttpProvider } from "./providers/customHttp";
import { loadImageMemory, mergeContextWithMemoryBudget } from "./memory";
import { callCodexVision } from "./providers/codex";

export interface TranslateRequest {
  image_url?: string;
  image_base64?: string;
  image_path?: string;
  language?: Language;
  detail?: Detail;
  context?: string;
}

export interface ModelClients {
  anthropic: Anthropic | null;
  openai: OpenAI | null;
}

export function createModelClients(cfg: AppConfig): ModelClients {
  return {
    anthropic: cfg.anthropicApiKey ? new Anthropic({ apiKey: cfg.anthropicApiKey }) : null,
    openai: cfg.openaiApiKey
      ? new OpenAI({
          apiKey: cfg.openaiApiKey,
          baseURL: cfg.openaiBaseUrl || undefined,
        })
      : null,
  };
}

export async function translateImage(
  cfg: AppConfig,
  clients: ModelClients,
  body: TranslateRequest
): Promise<{ text: string } | { error: string }> {
  const language: Language = body.language ?? "zh";
  const detail: Detail = body.detail ?? "standard";
  const memory = await loadImageMemory(cfg, {
    image_url: body.image_url,
    image_base64: body.image_base64,
    image_path: body.image_path,
  });
  const mergedContext = mergeContextWithMemoryBudget(cfg, body.context, memory);
  const memoryNoteForPrompt = memory?.note
    ? (memory.note.length > cfg.memoryMaxPromptChars
      ? `${memory.note.slice(0, Math.max(0, cfg.memoryMaxPromptChars - 3))}...`
      : memory.note)
    : undefined;
  const prompt = buildTranslatorPrompt(language, detail, mergedContext, memoryNoteForPrompt);
  const img = parseImageInput({
    image_url: body.image_url,
    image_base64: body.image_base64,
    image_path: body.image_path,
  });
  if (!img.ok) return { error: img.error };

  try {
    if (cfg.provider === "custom_http") {
      return callCustomHttpProvider(cfg, {
        image_url: body.image_url,
        image_base64: body.image_base64,
        image_path: body.image_path,
        language,
        detail,
        context: body.context,
      });
    }
    if (cfg.provider === "codex") {
      let imageUrlOrDataUrl: string;
      if (img.value.kind === "url") {
        imageUrlOrDataUrl = img.value.url;
      } else if (img.value.kind === "base64") {
        imageUrlOrDataUrl = `data:${img.value.mediaType};base64,${img.value.data}`;
      } else {
        const fromPath = await readPathImageAsBase64(img.value.filePath);
        imageUrlOrDataUrl = `data:${fromPath.mediaType};base64,${fromPath.data}`;
      }
      return callCodexVision(cfg, { prompt, imageUrlOrDataUrl });
    }

    let fixedPrepared: { openaiImageUrl: string; anthropicImageBlock: ImageBlockParam };
    if (img.value.kind === "url") {
      fixedPrepared = {
        openaiImageUrl: img.value.url,
        anthropicImageBlock: ({ type: "image", source: { type: "url", url: img.value.url } } as unknown as ImageBlockParam),
      };
    } else if (img.value.kind === "base64") {
      fixedPrepared = {
        openaiImageUrl: `data:${img.value.mediaType};base64,${img.value.data}`,
        anthropicImageBlock: {
          type: "image",
          source: {
            type: "base64",
            media_type: img.value.mediaType,
            data: img.value.data,
          },
        },
      };
    } else {
      const fromPath = await readPathImageAsBase64(img.value.filePath);
      fixedPrepared = {
        openaiImageUrl: `data:${fromPath.mediaType};base64,${fromPath.data}`,
        anthropicImageBlock: {
          type: "image",
          source: {
            type: "base64",
            media_type: fromPath.mediaType,
            data: fromPath.data,
          },
        },
      };
    }

    if (cfg.provider === "anthropic") {
      if (!clients.anthropic) return { error: "Anthropic client not initialized" };
      const response = await clients.anthropic.messages.create({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        messages: [{ role: "user", content: [fixedPrepared.anthropicImageBlock, { type: "text", text: prompt }] }],
      });
      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      return { text: text.trim() };
    }

    if (!clients.openai) return { error: "OpenAI client not initialized" };
    const completion = await clients.openai.chat.completions.create({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: fixedPrepared.openaiImageUrl } },
          ],
        },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? "";
    return { text: content.trim() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
