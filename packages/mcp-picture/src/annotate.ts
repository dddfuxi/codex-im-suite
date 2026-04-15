import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";
import OpenAI from "openai";
import sharp from "sharp";
import type { AppConfig } from "./config";
import type { ModelClients, TranslateRequest } from "./translate";
import { parseImageInput, readPathImageAsBase64, type ParsedImageInput } from "./imageInput";
import { callGroundingDino } from "./providers/groundingDino";
import { loadImageMemory, mergeContextWithMemoryBudget } from "./memory";
import { callCodexVision } from "./providers/codex";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SubjectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabeledObject {
  label: string;
  box: SubjectBox;
}

export type AnnotationStyle = "arrow" | "numbered";

export type ObjectsRequest = TranslateRequest & {
  output_path?: string;
  category?: string;
  /** Rendering style: "arrow" (default) draws arrows+labels; "numbered" draws badge numbers + side legend */
  style?: AnnotationStyle;
};

export type SceneKind =
  | "single_subject"
  | "structured_layout"
  | "dense_multi_object"
  | "natural_scene"
  | "unknown";

export interface AnnotationRoutingDecision {
  sceneKind: SceneKind;
  backend: "llm" | "grid_llm" | "grounding_dino";
  style: AnnotationStyle;
  reasoning: string;
}

// ─── Box helpers ─────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function normalizeBox(raw: SubjectBox): SubjectBox {
  const x = clamp01(raw.x);
  const y = clamp01(raw.y);
  return {
    x,
    y,
    width: Math.min(clamp01(raw.width), 1 - x),
    height: Math.min(clamp01(raw.height), 1 - y),
  };
}

function fallbackBox(): SubjectBox {
  return { x: 0.2, y: 0.18, width: 0.6, height: 0.64 };
}

function expandBox(box: SubjectBox, padX = 0.04, padY = 0.04): SubjectBox {
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  const right = Math.min(1, box.x + box.width + padX);
  const bottom = Math.min(1, box.y + box.height + padY);
  return normalizeBox({ x, y, width: right - x, height: bottom - y });
}

function remapBoxFromCrop(crop: SubjectBox, inner: SubjectBox): SubjectBox {
  return normalizeBox({
    x: crop.x + inner.x * crop.width,
    y: crop.y + inner.y * crop.height,
    width: inner.width * crop.width,
    height: inner.height * crop.height,
  });
}

// ─── JSON parsers ─────────────────────────────────────────────────────────────

function parseBoxFromText(text: string): SubjectBox | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Partial<SubjectBox>;
    if (
      typeof obj.x !== "number" ||
      typeof obj.y !== "number" ||
      typeof obj.width !== "number" ||
      typeof obj.height !== "number"
    ) return null;
    return normalizeBox({ x: obj.x, y: obj.y, width: obj.width, height: obj.height });
  } catch {
    return null;
  }
}

function parseLabeledObjectsFromText(text: string): LabeledObject[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
    const result: LabeledObject[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (
        typeof o.label === "string" &&
        typeof o.x === "number" &&
        typeof o.y === "number" &&
        typeof o.width === "number" &&
        typeof o.height === "number"
      ) {
        result.push({
          label: o.label.slice(0, 24),
          box: normalizeBox({ x: o.x, y: o.y, width: o.width, height: o.height }),
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** Parse grid-cell notation: [{label, col_start, row_start, col_end, row_end}] → LabeledObject[] */
function parseGridObjects(text: string, colCount = 10, rowCount = 10): LabeledObject[] {
  const COL_LABELS = "ABCDEFGHIJ".split("").slice(0, colCount);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
    const result: LabeledObject[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.label !== "string") continue;
      const cs = typeof o.col_start === "string" ? COL_LABELS.indexOf(o.col_start.toUpperCase()) : -1;
      const ceRaw = typeof o.col_end === "string" ? COL_LABELS.indexOf(o.col_end.toUpperCase()) : cs;
      const rs = typeof o.row_start === "number" ? Math.round(o.row_start) - 1 : -1;
      const reRaw = typeof o.row_end === "number" ? Math.round(o.row_end) - 1 : rs;
      if (cs < 0 || rs < 0 || rs >= rowCount) continue;
      const ce = Math.min(Math.max(ceRaw < 0 ? cs : ceRaw, cs), colCount - 1);
      const re = Math.min(Math.max(reRaw < 0 ? rs : reRaw, rs), rowCount - 1);
      result.push({
        label: o.label.slice(0, 24),
        box: normalizeBox({
          x: cs / colCount,
          y: rs / rowCount,
          width: (ce - cs + 1) / colCount,
          height: (re - rs + 1) / rowCount,
        }),
      });
    }
    return result;
  } catch {
    return [];
  }
}

function parseStringArrayFromText(text: string): string[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
    return arr.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

function parseRoutingDecisionFromText(text: string): AnnotationRoutingDecision | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const sceneKind = typeof obj.sceneKind === "string" ? obj.sceneKind : "";
    const backend = typeof obj.backend === "string" ? obj.backend : "";
    const style = typeof obj.style === "string" ? obj.style : "";
    const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
    if (
      (sceneKind !== "single_subject" &&
        sceneKind !== "structured_layout" &&
        sceneKind !== "dense_multi_object" &&
        sceneKind !== "natural_scene" &&
        sceneKind !== "unknown") ||
      (backend !== "llm" && backend !== "grid_llm" && backend !== "grounding_dino") ||
      (style !== "arrow" && style !== "numbered")
    ) {
      return null;
    }
    return { sceneKind, backend, style, reasoning: reasoning.slice(0, 240) };
  } catch {
    return null;
  }
}

// ─── Image input helpers ──────────────────────────────────────────────────────

async function toModelImageInput(parsed: ParsedImageInput): Promise<{
  imageUrlOrDataUrl: string;
  anthropicImageBlock: ImageBlockParam;
}> {
  if (parsed.kind === "url") {
    return {
      imageUrlOrDataUrl: parsed.url,
      anthropicImageBlock: { type: "image", source: { type: "url", url: parsed.url } } as unknown as ImageBlockParam,
    };
  }
  if (parsed.kind === "base64") {
    const dataUrl = `data:${parsed.mediaType};base64,${parsed.data}`;
    return {
      imageUrlOrDataUrl: dataUrl,
      anthropicImageBlock: {
        type: "image",
        source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
      },
    };
  }
  const fromPath = await readPathImageAsBase64(parsed.filePath);
  const dataUrl = `data:${fromPath.mediaType};base64,${fromPath.data}`;
  return {
    imageUrlOrDataUrl: dataUrl,
    anthropicImageBlock: {
      type: "image",
      source: { type: "base64", media_type: fromPath.mediaType, data: fromPath.data },
    },
  };
}

async function toModelImageInputFromBuffer(inputBuf: Buffer): Promise<{
  imageUrlOrDataUrl: string;
  anthropicImageBlock: ImageBlockParam;
}> {
  const encoded = await sharp(inputBuf).jpeg({ quality: 92 }).toBuffer();
  const data = encoded.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${data}`;
  return {
    imageUrlOrDataUrl: dataUrl,
    anthropicImageBlock: {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data },
    },
  };
}

async function readImageBuffer(parsed: ParsedImageInput): Promise<Buffer> {
  if (parsed.kind === "path") return fs.readFile(parsed.filePath);
  if (parsed.kind === "base64") return Buffer.from(parsed.data, "base64");
  const resp = await fetch(parsed.url);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function queryVisionText(
  cfg: AppConfig,
  clients: ModelClients,
  modelImage: { imageUrlOrDataUrl: string; anthropicImageBlock: ImageBlockParam },
  prompt: string,
  maxTokens: number,
  trace: string
): Promise<string> {
  try {
    if (cfg.provider === "anthropic" && clients.anthropic) {
      const resp = await clients.anthropic.messages.create({
        model: cfg.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: [modelImage.anthropicImageBlock, { type: "text", text: prompt }] }],
      });
      return resp.content[0]?.type === "text" ? resp.content[0].text : "";
    }

    if (cfg.provider === "openai" && clients.openai) {
      const resp = await clients.openai.chat.completions.create({
        model: cfg.model,
        max_tokens: maxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: modelImage.imageUrlOrDataUrl } },
          ],
        }],
      });
      return resp.choices[0]?.message?.content ?? "";
    }

    if (cfg.provider === "codex") {
      const result = await callCodexVision(cfg, {
        prompt,
        imageUrlOrDataUrl: modelImage.imageUrlOrDataUrl,
      });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return result.text;
    }
  } catch (error) {
    console.error(`[${trace}]`, error instanceof Error ? error.message : error);
  }

  return "";
}

function fallbackRoutingDecision(category: string): AnnotationRoutingDecision {
  const lowerCategory = category.trim().toLowerCase();
  if (["buildings", "rooms", "areas", "zones", "ui elements", "components"].includes(lowerCategory)) {
    return {
      sceneKind: "structured_layout",
      backend: "grid_llm",
      style: "numbered",
      reasoning: "Category suggests separated regions or repeated blocks.",
    };
  }
  return {
    sceneKind: "unknown",
    backend: "llm",
    style: "arrow",
    reasoning: "No strong scene hint was available.",
  };
}

async function classifySceneAndChooseStrategy(
  cfg: AppConfig,
  clients: ModelClients,
  modelImage: { imageUrlOrDataUrl: string; anthropicImageBlock: ImageBlockParam },
  category: string,
  guidance?: string
): Promise<AnnotationRoutingDecision> {
  const fallback = fallbackRoutingDecision(category);
  const groundingAllowed = Boolean(cfg.hfApiKey);
  const prompt =
    `Classify this image for annotation routing. Return ONLY JSON: ` +
    `{"sceneKind":"single_subject|structured_layout|dense_multi_object|natural_scene|unknown","backend":"llm|grid_llm|grounding_dino","style":"arrow|numbered","reasoning":"..."}. ` +
    `Definitions: structured_layout means maps, plans, blueprints, dashboards, diagrams, UI wireframes, partitioned scenes, or any image with clear region boundaries. ` +
    `dense_multi_object means many similar visible targets. single_subject means one dominant target. natural_scene means a general photo or screenshot without strong region structure. ` +
    `Choose grid_llm for structured layouts or dense repeated regions. Choose llm for single-subject or loose natural scenes. Choose grounding_dino only when many small precise objects need localization and it is available. ` +
    `If unsure, use unknown with llm and arrow.` +
    ` Category: ${category}. Grounding DINO available: ${groundingAllowed ? "yes" : "no"}.` +
    (guidance?.trim() ? ` Additional guidance: ${guidance.trim()}.` : "");

  const text = await queryVisionText(
    cfg,
    clients,
    modelImage,
    prompt,
    220,
    "classifySceneAndChooseStrategy"
  );
  return parseRoutingDecisionFromText(text) || fallback;
}

async function resolveAnnotationRouting(
  cfg: AppConfig,
  clients: ModelClients,
  modelImage: { imageUrlOrDataUrl: string; anthropicImageBlock: ImageBlockParam },
  category: string,
  requestedStyle: AnnotationStyle | undefined,
  guidance?: string
): Promise<AnnotationRoutingDecision> {
  const routed = await classifySceneAndChooseStrategy(cfg, clients, modelImage, category, guidance);
  const explicitBackend = cfg.annotationBackend === "auto" ? null : cfg.annotationBackend;
  const backend =
    explicitBackend === "grounding_dino" && !cfg.hfApiKey
      ? "grid_llm"
      : explicitBackend ?? (routed.backend === "grounding_dino" && !cfg.hfApiKey ? "grid_llm" : routed.backend);
  return {
    sceneKind: routed.sceneKind,
    backend,
    style: requestedStyle ?? routed.style,
    reasoning: explicitBackend ? `Backend forced by config: ${explicitBackend}. ${routed.reasoning}` : routed.reasoning,
  };
}

// ─── Grid helpers (Path A) ────────────────────────────────────────────────────

/** Build a semi-transparent 10x10 labeled grid SVG overlay. */
function buildGridSvg(W: number, H: number, cols = 10, rows = 10): string {
  const COL_LABELS = "ABCDEFGHIJ".split("").slice(0, cols);
  const cellW = W / cols;
  const cellH = H / rows;

  const lines: string[] = [];
  for (let c = 0; c <= cols; c++) {
    const x = Math.round(c * cellW);
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="rgba(40,40,40,0.45)" stroke-width="1"/>`);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.round(r * cellH);
    lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(40,40,40,0.45)" stroke-width="1"/>`);
  }

  const cellLabels: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round(c * cellW + 2);
      const y = Math.round(r * cellH + 13);
      const lbl = `${COL_LABELS[c]}${r + 1}`;
      const bgW = lbl.length * 5 + 4;
      cellLabels.push(
        `<rect x="${x - 1}" y="${y - 12}" width="${bgW}" height="14" fill="rgba(255,255,255,0.65)" rx="2"/>` +
        `<text x="${x}" y="${y}" font-size="10" font-family="Arial,monospace" fill="rgba(15,15,15,0.9)">${lbl}</text>`
      );
    }
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${lines.join("")}${cellLabels.join("")}</svg>`;
}

/** Composite a grid onto the image and return a JPEG data URL (for model input, not saved). */
async function buildGridDataUrl(inputBuf: Buffer, W: number, H: number): Promise<string> {
  const gridSvg = buildGridSvg(W, H);
  const jpegBuf = await sharp(inputBuf)
    .composite([{ input: Buffer.from(gridSvg) }])
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpegBuf.toString("base64")}`;
}

// ─── LLM locators ─────────────────────────────────────────────────────────────

async function locateMainSubjectBox(
  cfg: AppConfig,
  clients: ModelClients,
  modelImage: { imageUrlOrDataUrl: string; anthropicImageBlock: ImageBlockParam },
  guidance?: string
): Promise<SubjectBox> {
  const prompt =
    'Return only JSON: {"x":0-1,"y":0-1,"width":0-1,"height":0-1}. This box must tightly cover the main visual subject.' +
    (guidance?.trim() ? ` Use this guidance only if it matches the visible image: ${guidance.trim()}` : "");
  const text = await queryVisionText(cfg, clients, modelImage, prompt, 180, "locateMainSubjectBox");
  return parseBoxFromText(text) || fallbackBox();
}

/** Plain LLM locator: ask model for normalized float boxes directly. */
async function locateObjects(
  cfg: AppConfig,
  clients: ModelClients,
  modelImage: { imageUrlOrDataUrl: string; anthropicImageBlock: ImageBlockParam },
  category: string,
  language: string,
  guidance?: string
): Promise<LabeledObject[]> {
  const langNote = language === "zh" ? "用中文命名label" : "use English label";
  const prompt =
    `List all visible ${category} in this image. Return ONLY a JSON array (no markdown, no explanation): ` +
    `[{"label":"<name>","x":<0-1>,"y":<0-1>,"width":<0-1>,"height":<0-1>}, ...]. ` +
    `x/y/width/height are normalized 0-1 relative to image size. ${langNote}.` +
    " If the image is a structured diagram, layout, map, blueprint, UI wireframe, or other partitioned scene, each box must match one visually distinct region or block. Do not draw a loose box across multiple adjacent regions, long empty corridors, or large whitespace." +
    (guidance?.trim() ? ` Additional remembered guidance for this exact image: ${guidance.trim()}.` : "");
  const text = await queryVisionText(cfg, clients, modelImage, prompt, 1500, "locateObjects");
  return parseLabeledObjectsFromText(text);
}

/** Grid-assisted LLM locator (Path A): overlay grid → ask for grid-cell ranges → map back to coords. */
async function locateObjectsWithGrid(
  cfg: AppConfig,
  clients: ModelClients,
  inputBuf: Buffer,
  W: number,
  H: number,
  category: string,
  language: string,
  guidance?: string
): Promise<LabeledObject[]> {
  const gridDataUrl = await buildGridDataUrl(inputBuf, W, H);
  const langNote = language === "zh" ? "用中文命名label" : "use English label";
  const prompt =
    `The image has a 10x10 grid overlay. Columns A-J (left to right), rows 1-10 (top to bottom). ` +
    `Each cell is labeled (A1=top-left, J10=bottom-right). ` +
    `List all visible ${category}. Return ONLY a JSON array: ` +
    `[{"label":"<name>","col_start":"A","row_start":1,"col_end":"C","row_end":3}, ...]. ` +
    `col_start/col_end: a letter A-J. row_start/row_end: a number 1-10. ` +
    `${langNote}. No markdown, no extra text.` +
    " If the image is a structured diagram, layout, map, blueprint, UI wireframe, or other partitioned scene, use the smallest conservative grid range that still covers the actual region or block. Do not merge adjacent regions unless they are visibly one continuous target." +
    (guidance?.trim() ? ` Additional remembered guidance for this exact image: ${guidance.trim()}.` : "");

  const b64Data = gridDataUrl.split(",")[1];
  const gridModelImage: { imageUrlOrDataUrl: string; anthropicImageBlock: ImageBlockParam } = {
    imageUrlOrDataUrl: gridDataUrl,
    anthropicImageBlock: {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64Data },
    },
  };
  const text = await queryVisionText(
    cfg,
    clients,
    gridModelImage,
    prompt,
    2000,
    "locateObjectsWithGrid"
  );
  return parseGridObjects(text);
}

async function refineObjectsFromCrops(
  cfg: AppConfig,
  clients: ModelClients,
  inputBuf: Buffer,
  W: number,
  H: number,
  objects: LabeledObject[],
  language: string,
  guidance?: string
): Promise<LabeledObject[]> {
  const refined: LabeledObject[] = [];

  for (const obj of objects) {
    try {
      const crop = expandBox(obj.box, 0.05, 0.05);
      const left = Math.max(0, Math.floor(crop.x * W));
      const top = Math.max(0, Math.floor(crop.y * H));
      const width = Math.max(8, Math.min(W - left, Math.ceil(crop.width * W)));
      const height = Math.max(8, Math.min(H - top, Math.ceil(crop.height * H)));

      const cropBuf = await sharp(inputBuf)
        .extract({ left, top, width, height })
        .toBuffer();
      const cropImage = await toModelImageInputFromBuffer(cropBuf);

      const langNote = language === "zh" ? "use Chinese label if needed" : "use English label";
      const prompt =
        `Focus on the single target "${obj.label}" in this crop. ` +
        `Return ONLY JSON: {"x":0-1,"y":0-1,"width":0-1,"height":0-1}. ` +
        `The box must tightly cover that target inside this crop. ${langNote}. Prefer the actual object or region boundary, not surrounding text labels, arrows, decorative markers, or blank margin.` +
        (guidance?.trim() ? ` Additional guidance: ${guidance.trim()}` : "");

      const text = await queryVisionText(
        cfg,
        clients,
        cropImage,
        prompt,
        220,
        "refineObjectsFromCrops"
      );
      const inner = parseBoxFromText(text);

      refined.push({
        label: obj.label,
        box: inner ? remapBoxFromCrop(crop, inner) : obj.box,
      });
    } catch (e) {
      console.error("[refineObjectsFromCrops]", e instanceof Error ? e.message : e);
      refined.push(obj);
    }
  }

  return refined;
}

/** Step-1 of grounding-dino flow: ask LLM only for label names (no coordinates). */
async function identifyLabels(
  cfg: AppConfig,
  clients: ModelClients,
  modelImage: { imageUrlOrDataUrl: string; anthropicImageBlock: ImageBlockParam },
  category: string,
  language: string,
  guidance?: string
): Promise<string[]> {
  const langNote = language === "zh" ? "用中文" : "in English";
  const prompt =
    `List the names of all visible ${category} in this image ${langNote} as a JSON string array. ` +
    `No coordinates. Only: ["name1","name2",...].` +
    (guidance?.trim() ? ` Additional remembered guidance for this exact image: ${guidance.trim()}.` : "");
  const text = await queryVisionText(cfg, clients, modelImage, prompt, 400, "identifyLabels");
  return parseStringArrayFromText(text);
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const PALETTE = [
  "#E53935", "#1E88E5", "#43A047", "#FB8C00", "#8E24AA",
  "#00ACC1", "#F4511E", "#039BE5", "#7CB342", "#FFB300",
  "#D81B60", "#3949AB", "#00897B", "#C0CA33", "#6D4C41",
];

function pickColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

// ─── Renderers ─────────────────────────────────────────────────────────────────

function buildArrowSvgFragment(
  width: number,
  height: number,
  box: SubjectBox,
  label: string,
  color: string,
  index: number
): string {
  const px = Math.round(box.x * width);
  const py = Math.round(box.y * height);
  const pw = Math.round(box.width * width);
  const ph = Math.round(box.height * height);
  const centerX = px + Math.round(pw * 0.5);
  const centerY = py + Math.round(ph * 0.45);

  const angle = ((index * 137) % 360) * (Math.PI / 180);
  const radius = Math.min(width, height) * 0.18;
  const rawAnchorX = centerX + Math.round(Math.cos(angle) * radius);
  const rawAnchorY = centerY + Math.round(Math.sin(angle) * radius);
  const labelW = Math.max(70, label.length * 14 + 16);
  const labelH = 30;
  const anchorX = Math.min(Math.max(rawAnchorX, labelW / 2 + 4), width - labelW / 2 - 4);
  const anchorY = Math.min(Math.max(rawAnchorY, labelH + 4), height - 4);

  const head = Math.max(10, Math.round(Math.min(width, height) * 0.016));
  const dx = centerX - anchorX;
  const dy = centerY - anchorY;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const arrowTipX = centerX - ux * 4;
  const arrowTipY = centerY - uy * 4;
  const bx = arrowTipX - ux * head;
  const by = arrowTipY - uy * head;
  const nx = -uy;
  const ny = ux;
  const p1x = Math.round(bx + nx * (head * 0.5));
  const p1y = Math.round(by + ny * (head * 0.5));
  const p2x = Math.round(bx - nx * (head * 0.5));
  const p2y = Math.round(by - ny * (head * 0.5));

  const strokeW = Math.max(2, Math.round(Math.min(width, height) * 0.004));
  const labelX = Math.round(anchorX - labelW / 2);
  const labelY = Math.round(anchorY - labelH);
  const fontSize = Math.max(12, Math.round(Math.min(width, height) * 0.018));

  return `
  <rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="5"
    fill="none" stroke="${color}" stroke-width="${strokeW + 1}" stroke-dasharray="8 4"/>
  <line x1="${anchorX}" y1="${anchorY}" x2="${arrowTipX}" y2="${arrowTipY}"
    stroke="${color}" stroke-width="${strokeW + 1}" stroke-linecap="round"/>
  <polygon points="${arrowTipX},${arrowTipY} ${p1x},${p1y} ${p2x},${p2y}" fill="${color}"/>
  <rect x="${labelX}" y="${labelY}" width="${labelW}" height="${labelH}" rx="7"
    fill="${color}" fill-opacity="0.92"/>
  <text x="${labelX + 8}" y="${labelY + labelH - 8}"
    font-size="${fontSize}" font-family="Arial, Microsoft YaHei, sans-serif" fill="#FFFFFF"
    font-weight="bold">${label}</text>`;
}

function buildSingleOverlaySvg(width: number, height: number, box: SubjectBox): string {
  const px = Math.round(box.x * width);
  const py = Math.round(box.y * height);
  const pw = Math.round(box.width * width);
  const ph = Math.round(box.height * height);
  const targetX = px + Math.round(pw * 0.5);
  const targetY = py + Math.round(ph * 0.42);
  const startX = Math.max(28, Math.round(width * 0.1));
  const startY = Math.max(30, Math.round(height * 0.12));
  const labelX = Math.max(12, startX - 8);
  const labelY = Math.max(24, startY - 10);
  const head = 16;
  const dx = targetX - startX;
  const dy = targetY - startY;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const bx = targetX - ux * head;
  const by = targetY - uy * head;
  const nx = -uy;
  const ny = ux;
  const p1x = Math.round(bx + nx * (head * 0.48));
  const p1y = Math.round(by + ny * (head * 0.48));
  const p2x = Math.round(bx - nx * (head * 0.48));
  const p2y = Math.round(by - ny * (head * 0.48));
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="6" fill="none" stroke="#FF2B2B" stroke-width="4"/>
  <line x1="${startX}" y1="${startY}" x2="${targetX}" y2="${targetY}" stroke="#FF2B2B" stroke-width="6" stroke-linecap="round"/>
  <polygon points="${targetX},${targetY} ${p1x},${p1y} ${p2x},${p2y}" fill="#FF2B2B"/>
  <rect x="${labelX - 8}" y="${labelY - 26}" width="66" height="32" rx="8" fill="rgba(255,43,43,0.92)"/>
  <text x="${labelX}" y="${labelY - 4}" font-size="18" font-family="Arial, Microsoft YaHei, sans-serif" fill="#FFFFFF">主体</text>
</svg>`;
}

function buildMultiOverlaySvg(width: number, height: number, objects: LabeledObject[]): string {
  const fragments = objects.map((obj, i) =>
    buildArrowSvgFragment(width, height, obj.box, obj.label, pickColor(i), i)
  );
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
${fragments.join("\n")}
</svg>`;
}

/**
 * Numbered style renderer (Path C):
 * - Draws a colored numbered badge at the top-left corner of each bounding box
 * - Extends the canvas to the right with a legend panel listing all labels
 * - No arrows, no label-overlap issues
 */
function buildNumberedOverlaySvg(
  imgW: number,
  imgH: number,
  objects: LabeledObject[],
  legendPanelW: number
): string {
  const totalW = imgW + legendPanelW;
  const badgeR = Math.max(14, Math.round(Math.min(imgW, imgH) * 0.022));
  const badgeFontSize = Math.max(10, badgeR - 4);
  const strokeW = Math.max(2, Math.round(Math.min(imgW, imgH) * 0.003));

  const boxFragments = objects.map((obj, i) => {
    const num = i + 1;
    const color = pickColor(i);
    const px = Math.round(obj.box.x * imgW);
    const py = Math.round(obj.box.y * imgH);
    const pw = Math.round(obj.box.width * imgW);
    const ph = Math.round(obj.box.height * imgH);
    // Badge at the visual center of the box (not corner) so it always lands on the building body
    const bx = px + Math.round(pw * 0.5);
    const by = py + Math.round(ph * 0.45);
    return `
  <rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="4"
    fill="rgba(0,0,0,0.04)" stroke="${color}" stroke-width="${strokeW + 1}" stroke-dasharray="7 3"/>
  <circle cx="${bx}" cy="${by}" r="${badgeR}" fill="${color}"/>
  <text x="${bx}" y="${by + badgeFontSize * 0.38}" text-anchor="middle"
    font-size="${badgeFontSize}" font-family="Arial, sans-serif" fill="#FFFFFF" font-weight="bold">${num}</text>`;
  });

  const legendFontSize = Math.max(13, Math.round(Math.min(imgW, imgH) * 0.018));
  const topPad = 28;
  const smallR = Math.max(10, Math.round(legendFontSize * 0.65));
  const available = imgH - topPad - 12;
  const rawEntryH = smallR * 2 + 8;
  const entryH = Math.min(rawEntryH + 8, Math.max(rawEntryH, Math.floor(available / objects.length)));
  const legendX = imgW + 10;

  const legendItems = objects.map((obj, i) => {
    const num = i + 1;
    const color = pickColor(i);
    const cy = topPad + i * entryH + smallR;
    const textY = cy + legendFontSize * 0.38;
    return `
  <circle cx="${legendX + smallR}" cy="${cy}" r="${smallR}" fill="${color}"/>
  <text x="${legendX + smallR}" y="${cy + Math.max(9, smallR - 3) * 0.42}" text-anchor="middle"
    font-size="${Math.max(9, smallR - 3)}" font-family="Arial, sans-serif" fill="#FFFFFF" font-weight="bold">${num}</text>
  <text x="${legendX + smallR * 2 + 8}" y="${textY}"
    font-size="${legendFontSize}" font-family="Arial, Microsoft YaHei, sans-serif" fill="#222222">${obj.label}</text>`;
  });

  const legendBg = `
  <rect x="${imgW}" y="0" width="${legendPanelW}" height="${imgH}" fill="#F5F5F5"/>
  <line x1="${imgW + 0.5}" y1="0" x2="${imgW + 0.5}" y2="${imgH}" stroke="#CCCCCC" stroke-width="1"/>
  <text x="${imgW + legendPanelW / 2}" y="18" text-anchor="middle"
    font-size="12" font-family="Arial, sans-serif" fill="#888888" font-weight="bold">图 例</text>`;

  return `<svg width="${totalW}" height="${imgH}" viewBox="0 0 ${totalW} ${imgH}" xmlns="http://www.w3.org/2000/svg">
${legendBg}
${boxFragments.join("")}
${legendItems.join("")}
</svg>`;
}

// ─── Main export functions ───────────────────────────────────────────────────

export interface DetectedObjectsResult {
  inputBuffer: Buffer;
  width: number;
  height: number;
  objects: LabeledObject[];
  routing: AnnotationRoutingDecision;
  style: AnnotationStyle;
}

function resolveOutputPath(outputPath?: string, prefix = "objects"): string {
  if (outputPath?.trim()) return path.resolve(process.cwd(), outputPath.trim());
  return path.join(path.resolve(process.cwd(), "output"), `${prefix}-${Date.now()}.png`);
}

export async function renderAnnotatedObjectsImage(params: {
  inputBuffer: Buffer;
  width: number;
  height: number;
  objects: LabeledObject[];
  style?: AnnotationStyle;
  output_path?: string;
}): Promise<{ outputPath: string } | { error: string }> {
  if (params.objects.length === 0) return { error: "No objects available for annotation" };

  try {
    const outPath = resolveOutputPath(params.output_path, "objects");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const style = params.style ?? "arrow";

    if (style === "numbered") {
      const maxLabelLen = Math.max(...params.objects.map((obj) => obj.label.length));
      const legendPanelW = Math.max(160, maxLabelLen * 14 + 80);
      const extendedBuf = await sharp(params.inputBuffer)
        .extend({ right: legendPanelW, background: { r: 245, g: 245, b: 245, alpha: 255 } })
        .toBuffer();
      const overlaySvg = buildNumberedOverlaySvg(params.width, params.height, params.objects, legendPanelW);
      await sharp(extendedBuf).composite([{ input: Buffer.from(overlaySvg) }]).png().toFile(outPath);
    } else {
      const overlaySvg = buildMultiOverlaySvg(params.width, params.height, params.objects);
      await sharp(params.inputBuffer).composite([{ input: Buffer.from(overlaySvg) }]).png().toFile(outPath);
    }

    return { outputPath: outPath };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function detectObjectsInImage(
  cfg: AppConfig,
  clients: ModelClients,
  req: ObjectsRequest
): Promise<DetectedObjectsResult | { error: string }> {
  const parsed = parseImageInput({
    image_url: req.image_url,
    image_base64: req.image_base64,
    image_path: req.image_path,
  });
  if (!parsed.ok) return { error: parsed.error };

  try {
    const memory = await loadImageMemory(cfg, {
      image_url: req.image_url,
      image_base64: req.image_base64,
      image_path: req.image_path,
    });
    const guidance = mergeContextWithMemoryBudget(cfg, req.context, memory);
    const inputBuf = await readImageBuffer(parsed.value);
    const meta = await sharp(inputBuf).metadata();
    if (!meta.width || !meta.height) return { error: "Unable to read image size" };

    const category = req.category?.trim() || "buildings";
    const language = req.language ?? "zh";
    const modelImage = await toModelImageInput(parsed.value);
    const routing = await resolveAnnotationRouting(cfg, clients, modelImage, category, req.style, guidance);

    let objects: LabeledObject[];
    if (routing.backend === "grounding_dino") {
      if (!cfg.hfApiKey) {
        return { error: "HF_API_KEY is not set (ANNOTATION_BACKEND=grounding_dino)" };
      }
      const labels = await identifyLabels(cfg, clients, modelImage, category, language, guidance);
      if (labels.length === 0) {
        return { error: `LLM could not identify ${category} labels for Grounding DINO` };
      }
      const imgDataUrl =
        `data:image/jpeg;base64,${(await sharp(inputBuf).jpeg({ quality: 90 }).toBuffer()).toString("base64")}`;
      objects = await callGroundingDino(imgDataUrl, meta.width, meta.height, labels, cfg.hfApiKey, cfg.groundingDinoModel);
    } else if (routing.backend === "grid_llm") {
      const coarseObjects = await locateObjectsWithGrid(
        cfg,
        clients,
        inputBuf,
        meta.width,
        meta.height,
        category,
        language,
        guidance
      );
      objects =
        coarseObjects.length > 0
          ? await refineObjectsFromCrops(cfg, clients, inputBuf, meta.width, meta.height, coarseObjects, language, guidance)
          : coarseObjects;
    } else {
      objects = await locateObjects(cfg, clients, modelImage, category, language, guidance);
    }

    if (objects.length === 0) {
      return { error: `No ${category} detected in image` };
    }

    return {
      inputBuffer: inputBuf,
      width: meta.width,
      height: meta.height,
      objects,
      routing,
      style: routing.style,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createSubjectAnnotatedImage(
  cfg: AppConfig,
  clients: ModelClients,
  req: TranslateRequest & { output_path?: string }
): Promise<{ outputPath: string; subjectBox: SubjectBox; routing: AnnotationRoutingDecision } | { error: string }> {
  const parsed = parseImageInput({
    image_url: req.image_url,
    image_base64: req.image_base64,
    image_path: req.image_path,
  });
  if (!parsed.ok) return { error: parsed.error };

  try {
    const memory = await loadImageMemory(cfg, {
      image_url: req.image_url,
      image_base64: req.image_base64,
      image_path: req.image_path,
    });
    const guidance = mergeContextWithMemoryBudget(cfg, req.context, memory);
    const modelImage = await toModelImageInput(parsed.value);
    const routing = await resolveAnnotationRouting(cfg, clients, modelImage, "subject", "arrow", guidance);
    const box = await locateMainSubjectBox(cfg, clients, modelImage, guidance);
    const inputBuf = await readImageBuffer(parsed.value);
    const meta = await sharp(inputBuf).metadata();
    if (!meta.width || !meta.height) return { error: "Unable to read image size" };
    const overlay = Buffer.from(buildSingleOverlaySvg(meta.width, meta.height, box));
    const outDir = path.resolve(process.cwd(), "output");
    await fs.mkdir(outDir, { recursive: true });
    const outPath = req.output_path?.trim()
      ? path.resolve(process.cwd(), req.output_path.trim())
      : path.join(outDir, `annotated-${Date.now()}.png`);
    await sharp(inputBuf).composite([{ input: overlay }]).png().toFile(outPath);
    return { outputPath: outPath, subjectBox: box, routing };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createObjectsAnnotatedImage(
  cfg: AppConfig,
  clients: ModelClients,
  req: ObjectsRequest
): Promise<{ outputPath: string; objects: LabeledObject[]; routing: AnnotationRoutingDecision } | { error: string }> {
  const parsed = parseImageInput({
    image_url: req.image_url,
    image_base64: req.image_base64,
    image_path: req.image_path,
  });
  if (!parsed.ok) return { error: parsed.error };

  try {
    const memory = await loadImageMemory(cfg, {
      image_url: req.image_url,
      image_base64: req.image_base64,
      image_path: req.image_path,
    });
    const guidance = mergeContextWithMemoryBudget(cfg, req.context, memory);
    const inputBuf = await readImageBuffer(parsed.value);
    const meta = await sharp(inputBuf).metadata();
    if (!meta.width || !meta.height) return { error: "Unable to read image size" };

    const category = req.category?.trim() || "buildings";
    const language = req.language ?? "zh";
    const modelImage = await toModelImageInput(parsed.value);
    const routing = await resolveAnnotationRouting(cfg, clients, modelImage, category, req.style, guidance);

    let objects: LabeledObject[];

    if (routing.backend === "grounding_dino") {
      if (!cfg.hfApiKey) {
        return { error: "HF_API_KEY is not set (ANNOTATION_BACKEND=grounding_dino)" };
      }
      // Two-stage: LLM → label names, Grounding DINO → precise boxes
      const labels = await identifyLabels(cfg, clients, modelImage, category, language, guidance);
      if (labels.length === 0) {
        return { error: `LLM could not identify ${category} labels for Grounding DINO` };
      }
      const imgDataUrl =
        `data:image/jpeg;base64,${(await sharp(inputBuf).jpeg({ quality: 90 }).toBuffer()).toString("base64")}`;
      objects = await callGroundingDino(imgDataUrl, meta.width, meta.height, labels, cfg.hfApiKey, cfg.groundingDinoModel);
    } else if (routing.backend === "grid_llm") {
      const coarseObjects = await locateObjectsWithGrid(cfg, clients, inputBuf, meta.width, meta.height, category, language, guidance);
      objects = coarseObjects.length > 0
        ? await refineObjectsFromCrops(cfg, clients, inputBuf, meta.width, meta.height, coarseObjects, language, guidance)
        : coarseObjects;
    } else {
      objects = await locateObjects(cfg, clients, modelImage, category, language, guidance);
    }

    if (objects.length === 0) {
      return { error: `No ${category} detected in image` };
    }

    const style: AnnotationStyle = routing.style;
    const outDir = path.resolve(process.cwd(), "output");
    await fs.mkdir(outDir, { recursive: true });
    const outPath = req.output_path?.trim()
      ? path.resolve(process.cwd(), req.output_path.trim())
      : path.join(outDir, `objects-${Date.now()}.png`);

    if (style === "numbered") {
      const maxLabelLen = Math.max(...objects.map(o => o.label.length));
      const legendPanelW = Math.max(160, maxLabelLen * 14 + 80);
      const extendedBuf = await sharp(inputBuf)
        .extend({ right: legendPanelW, background: { r: 245, g: 245, b: 245, alpha: 255 } })
        .toBuffer();
      const overlaySvg = buildNumberedOverlaySvg(meta.width, meta.height, objects, legendPanelW);
      await sharp(extendedBuf).composite([{ input: Buffer.from(overlaySvg) }]).png().toFile(outPath);
    } else {
      const overlaySvg = buildMultiOverlaySvg(meta.width, meta.height, objects);
      await sharp(inputBuf).composite([{ input: Buffer.from(overlaySvg) }]).png().toFile(outPath);
    }

    return { outputPath: outPath, objects, routing };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Silence unused-import warnings for named imports only used as types
void (Anthropic as unknown);
void (OpenAI as unknown);
