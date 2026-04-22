import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface IgnisAskInput {
  prompt?: string;
  async?: boolean;
  new_session?: boolean;
  session_id?: string;
  canvas_id?: string;
  agent?: string;
  file_ids?: string[];
  attachments?: string[];
  wait_ms?: number;
  timeout_ms?: number;
}

export interface IgnisResultInput {
  turn_id?: string;
  session_id?: string;
}

export interface IgnisWaitInput extends IgnisResultInput {
  timeout_ms?: number;
}

export interface IgnisUploadInput {
  path?: string;
}

export interface IgnisHistoryInput {
  session_id?: string;
  limit?: number;
  offset?: number;
  messages?: boolean;
  all?: boolean;
}

export interface IgnisSkillsInput {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface IgnisResumeInput {
  turn_id?: string;
  answers?: string[];
  payload?: string;
  cancel?: boolean;
  async?: boolean;
  wait_ms?: number;
  timeout_ms?: number;
}

export interface IgnisCommandResult {
  ok: boolean;
  command: string;
  rawText: string;
  data?: unknown;
  summary: IgnisSummary;
}

export interface IgnisSummary {
  turnIds: string[];
  sessionIds: string[];
  canvasIds: string[];
  fileIds: string[];
  canvasUrls: string[];
  cdnUrls: string[];
}

const DEFAULT_TIMEOUT_MS = 300000;
const CDN_BASE_URL = "https://cdn-asia.funplus-marketing.ai/ultra";

function findIgnisEntrypoint(): string | undefined {
  const candidates: string[] = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "ignis-agent-cli", "dist", "index.js"));
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir.trim()) continue;
    candidates.push(path.join(dir, "node_modules", "ignis-agent-cli", "dist", "index.js"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function getIgnisExecution(): { command: string; argsPrefix: string[] } {
  const entrypoint = findIgnisEntrypoint();
  if (entrypoint) {
    return { command: process.execPath, argsPrefix: [entrypoint] };
  }
  return { command: "ignis", argsPrefix: [] };
}

function getIgnisConfigPath(): string {
  return path.join(os.homedir(), ".ignis", "config.json");
}

function ensureIgnisConfig(): void {
  const configPath = getIgnisConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`Ignis config missing: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as { baseUrl?: unknown; cliToken?: unknown };
  if (typeof parsed.baseUrl !== "string" || typeof parsed.cliToken !== "string") {
    throw new Error(`Ignis config is incomplete: ${configPath}`);
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function parseJson(rawText: string): unknown {
  const text = rawText.trim().replace(/^\uFEFF/, "");
  if (!text) return {};
  return JSON.parse(text);
}

function collectValues(value: unknown, keyName: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, keyName, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === keyName && typeof nested === "string" && nested.trim()) out.add(nested.trim());
    if (key === `${keyName}s` && Array.isArray(nested)) {
      for (const item of nested) {
        if (typeof item === "string" && item.trim()) out.add(item.trim());
      }
    }
    collectValues(nested, keyName, out);
  }
}

function summarize(data: unknown): IgnisSummary {
  const turnIds = new Set<string>();
  const sessionIds = new Set<string>();
  const canvasIds = new Set<string>();
  const fileIds = new Set<string>();
  collectValues(data, "turn_id", turnIds);
  collectValues(data, "session_id", sessionIds);
  collectValues(data, "canvas_id", canvasIds);
  collectValues(data, "file_id", fileIds);

  return {
    turnIds: [...turnIds],
    sessionIds: [...sessionIds],
    canvasIds: [...canvasIds],
    fileIds: [...fileIds],
    canvasUrls: [...canvasIds].map((id) => `https://ignis.funplus-marketing.ai/canvas/${id}`),
    cdnUrls: [...fileIds].map((id) => `${CDN_BASE_URL}/${id}`),
  };
}

function buildResult(command: string, rawText: string): IgnisCommandResult {
  let data: unknown;
  try {
    data = parseJson(rawText);
  } catch {
    data = { text: rawText.trim() };
  }
  return {
    ok: true,
    command,
    rawText: rawText.trim(),
    data,
    summary: summarize(data),
  };
}

async function runIgnis(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<IgnisCommandResult> {
  ensureIgnisConfig();
  const command = `ignis ${args.map((item) => (/\s/.test(item) ? `"${item}"` : item)).join(" ")}`;
  const execution = getIgnisExecution();
  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, [...execution.argsPrefix, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Ignis command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if ((code ?? 1) !== 0) {
        reject(new Error((stderr || stdout || `ignis exited with code ${code ?? 1}`).trim()));
        return;
      }
      resolve(buildResult(command, stdout || stderr));
    });
  });
}

export async function ignisAsk(input: IgnisAskInput): Promise<IgnisCommandResult> {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const args = ["ask", "--json"];
  if (input.async !== false) args.push("--async");
  if (input.new_session === true) args.push("--new");
  if (input.session_id) args.push("--session", input.session_id);
  if (input.canvas_id) args.push("--canvas", input.canvas_id);
  if (input.agent) args.push("--agent", input.agent);
  for (const fileId of asStringArray(input.file_ids)) args.push("--file-id", fileId);
  for (const attachment of asStringArray(input.attachments)) args.push("--attach", attachment);
  if (input.wait_ms) args.push("--wait-ms", String(positiveInt(input.wait_ms, 25000)));
  if (input.timeout_ms) args.push("--timeout-ms", String(positiveInt(input.timeout_ms, DEFAULT_TIMEOUT_MS)));
  args.push(prompt);
  return runIgnis(args, positiveInt(input.timeout_ms, DEFAULT_TIMEOUT_MS));
}

export async function ignisResult(input: IgnisResultInput): Promise<IgnisCommandResult> {
  const args = ["result", "--json"];
  if (input.session_id) args.push("--session", input.session_id);
  if (input.turn_id) args.push(input.turn_id);
  if (!input.turn_id && !input.session_id) throw new Error("turn_id or session_id is required");
  return runIgnis(args, 60000);
}

export async function ignisWait(input: IgnisWaitInput): Promise<IgnisCommandResult> {
  const timeoutMs = positiveInt(input.timeout_ms, DEFAULT_TIMEOUT_MS);
  const args = ["wait", "--json"];
  if (input.session_id) args.push("--session", input.session_id);
  if (input.timeout_ms) args.push("--timeout-ms", String(timeoutMs));
  if (input.turn_id) args.push(input.turn_id);
  if (!input.turn_id && !input.session_id) throw new Error("turn_id or session_id is required");
  return runIgnis(args, timeoutMs + 5000);
}

export async function ignisUpload(input: IgnisUploadInput): Promise<IgnisCommandResult> {
  const filePath = String(input.path || "").trim();
  if (!filePath) throw new Error("path is required");
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  return runIgnis(["upload", "--json", filePath], 120000);
}

export async function ignisHistory(input: IgnisHistoryInput): Promise<IgnisCommandResult> {
  const args = ["history", "--json"];
  if (input.session_id) args.push("--session", input.session_id);
  if (input.limit) args.push("--limit", String(positiveInt(input.limit, 20)));
  if (input.offset) args.push("--offset", String(positiveInt(input.offset, 0)));
  if (input.messages === true) args.push("--messages");
  if (input.all === true) args.push("--all");
  return runIgnis(args, 60000);
}

export async function ignisSkills(input: IgnisSkillsInput): Promise<IgnisCommandResult> {
  const args = ["skills", "--json"];
  if (input.query) args.push("--query", input.query);
  if (input.limit) args.push("--limit", String(positiveInt(input.limit, 50)));
  if (input.offset) args.push("--offset", String(positiveInt(input.offset, 0)));
  return runIgnis(args, 60000);
}

export async function ignisResume(input: IgnisResumeInput): Promise<IgnisCommandResult> {
  const turnId = String(input.turn_id || "").trim();
  if (!turnId) throw new Error("turn_id is required");
  const timeoutMs = positiveInt(input.timeout_ms, DEFAULT_TIMEOUT_MS);
  const args = ["resume", "--json", turnId];
  if (input.cancel === true) args.push("--cancel");
  for (const answer of asStringArray(input.answers)) args.push("--answer", answer);
  if (input.payload) args.push("--payload", input.payload);
  if (input.async === true) args.push("--async");
  if (input.wait_ms) args.push("--wait-ms", String(positiveInt(input.wait_ms, 25000)));
  if (input.timeout_ms) args.push("--timeout-ms", String(timeoutMs));
  return runIgnis(args, timeoutMs + 5000);
}

export function createTempAttachment(name: string, mimeType: string, base64Data: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "attachment";
  const ext = path.extname(safeName) || mimeToExt(mimeType);
  const filePath = path.join(os.tmpdir(), `cti-ignis-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

function mimeToExt(mimeType: string): string {
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("gif")) return ".gif";
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("pdf")) return ".pdf";
  return ".bin";
}
