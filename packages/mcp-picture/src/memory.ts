import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import { parseImageInput, type ParsedImageInput } from "./imageInput";

export interface ImageMemoryRecord {
  imageHash: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  source?: string;
}

function truncateForPrompt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function readImageBuffer(parsed: ParsedImageInput): Promise<Buffer> {
  if (parsed.kind === "path") return fs.readFile(parsed.filePath);
  if (parsed.kind === "base64") return Buffer.from(parsed.data, "base64");
  const response = await fetch(parsed.url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function getMemoryPath(cfg: AppConfig, imageHash: string): string {
  return path.resolve(process.cwd(), cfg.memoryDir, `${imageHash}.json`);
}

async function writeImageMemoryRecord(
  cfg: AppConfig,
  imageHash: string,
  record: ImageMemoryRecord
): Promise<void> {
  const memoryDir = path.resolve(process.cwd(), cfg.memoryDir);
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(getMemoryPath(cfg, imageHash), JSON.stringify(record, null, 2), "utf8");
}

export async function fingerprintImageInput(input: {
  image_url?: string;
  image_base64?: string;
  image_path?: string;
}): Promise<{ imageHash: string } | { error: string }> {
  const parsed = parseImageInput(input);
  if (!parsed.ok) return { error: parsed.error };

  try {
    const buffer = await readImageBuffer(parsed.value);
    const imageHash = crypto.createHash("sha256").update(buffer).digest("hex");
    return { imageHash };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadImageMemory(
  cfg: AppConfig,
  input: {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
  }
): Promise<ImageMemoryRecord | null> {
  const fingerprint = await fingerprintImageInput(input);
  if ("error" in fingerprint) return null;

  try {
    const raw = await fs.readFile(getMemoryPath(cfg, fingerprint.imageHash), "utf8");
    return JSON.parse(raw) as ImageMemoryRecord;
  } catch {
    return null;
  }
}

export async function saveImageMemory(
  cfg: AppConfig,
  input: {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
  },
  note: string,
  source?: string
): Promise<ImageMemoryRecord | { error: string }> {
  const trimmed = note.trim();
  if (!trimmed) return { error: "note is required" };
  const storedNote = truncateForPrompt(trimmed, cfg.memoryMaxStoredChars);

  const fingerprint = await fingerprintImageInput(input);
  if ("error" in fingerprint) return { error: fingerprint.error };

  const previous = await loadImageMemory(cfg, input);
  const now = new Date().toISOString();
  const record: ImageMemoryRecord = {
    imageHash: fingerprint.imageHash,
    note: storedNote,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    ...(source ? { source } : previous?.source ? { source: previous.source } : {}),
  };

  await writeImageMemoryRecord(cfg, fingerprint.imageHash, record);
  return record;
}

export function mergeContextWithMemory(context?: string, memory?: ImageMemoryRecord | null): string | undefined {
  const trimmedContext = context?.trim();
  const memoryNote = memory?.note?.trim();
  if (trimmedContext && memoryNote) {
    return `${trimmedContext}\n\nRemembered image context:\n${memoryNote}`;
  }
  if (memoryNote) {
    return `Remembered image context:\n${memoryNote}`;
  }
  return trimmedContext || undefined;
}

export function mergeContextWithMemoryBudget(
  cfg: AppConfig,
  context?: string,
  memory?: ImageMemoryRecord | null
): string | undefined {
  const compactContext = truncateForPrompt(context || "", cfg.contextMaxPromptChars);
  const compactMemory = truncateForPrompt(memory?.note || "", cfg.memoryMaxPromptChars);

  if (compactContext && compactMemory) {
    return `${compactContext}\n\nRemembered image context (trimmed):\n${compactMemory}`;
  }
  if (compactMemory) {
    return `Remembered image context (trimmed):\n${compactMemory}`;
  }
  return compactContext || undefined;
}
