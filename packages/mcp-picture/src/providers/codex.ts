import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config";

type CodexModule = any;
type CodexClient = any;

let cachedCodexModule: CodexModule | null = null;
let cachedCodexClient: CodexClient | null = null;

async function ensureCodexClient(): Promise<CodexClient> {
  if (cachedCodexClient) return cachedCodexClient;

  if (!cachedCodexModule) {
    try {
      cachedCodexModule = await import("@openai/codex-sdk");
    } catch {
      throw new Error(
        "Codex SDK is not installed. Run: npm install @openai/codex-sdk"
      );
    }
  }

  const CodexClass = cachedCodexModule.Codex;
  cachedCodexClient = new CodexClass({
    ...(process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {}),
    ...(process.env.CODEX_BASE_URL ? { baseUrl: process.env.CODEX_BASE_URL } : {}),
    config: {
      model_reasoning_effort: process.env.CODEX_REASONING_EFFORT || "low",
    },
  });
  return cachedCodexClient;
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const matched = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!matched) return null;
  return {
    mimeType: matched[1].toLowerCase(),
    data: matched[2],
  };
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

async function toLocalImagePath(imageUrlOrDataUrl: string): Promise<string> {
  const parsed = parseDataUrl(imageUrlOrDataUrl);
  if (parsed) {
    const tmpPath = path.join(
      os.tmpdir(),
      `mcp-picture-codex-${Date.now()}-${Math.random().toString(36).slice(2)}${mimeToExt(parsed.mimeType)}`
    );
    await fs.writeFile(tmpPath, Buffer.from(parsed.data, "base64"));
    return tmpPath;
  }

  const response = await fetch(imageUrlOrDataUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image for Codex: HTTP ${response.status}`);
  }
  const mimeType = (response.headers.get("content-type") || "image/png").split(";")[0].trim().toLowerCase();
  const imageBuffer = Buffer.from(await response.arrayBuffer());
  const tmpPath = path.join(
    os.tmpdir(),
    `mcp-picture-codex-${Date.now()}-${Math.random().toString(36).slice(2)}${mimeToExt(mimeType)}`
  );
  await fs.writeFile(tmpPath, imageBuffer);
  return tmpPath;
}

function extractFinalText(result: any): string {
  const direct = typeof result?.finalResponse === "string" ? result.finalResponse.trim() : "";
  if (direct) return direct;

  const items = Array.isArray(result?.items) ? result.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agent_message" && typeof item?.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "";
}

export async function callCodexVision(
  cfg: AppConfig,
  input: {
    prompt: string;
    imageUrlOrDataUrl: string;
  }
): Promise<{ text: string } | { error: string }> {
  let localImagePath: string | null = null;
  try {
    const codex = await ensureCodexClient();
    localImagePath = await toLocalImagePath(input.imageUrlOrDataUrl);

    const thread = codex.startThread({
      model: cfg.model,
      sandboxMode: process.env.CODEX_SANDBOX_MODE || "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: process.env.CODEX_REASONING_EFFORT || "low",
    });

    const turnResult = await thread.run([
      { type: "text", text: input.prompt },
      { type: "local_image", path: localImagePath },
    ]);
    const text = extractFinalText(turnResult);
    if (!text) {
      return { error: "Codex returned empty response" };
    }
    return { text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (localImagePath) {
      await fs.unlink(localImagePath).catch(() => undefined);
    }
  }
}
