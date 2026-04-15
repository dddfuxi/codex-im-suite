/**
 * 本地渲染测试：用已知坐标跳过模型调用，
 * 同时输出 arrow 和 numbered 两种风格
 */
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import type { LabeledObject } from "../src/annotate.js";

// 网格校准坐标 v3 — 对照 city_grid_preview.jpg (A1-J10) 精定位
// 公式: col A=0, B=0.1, ..., J=0.9 | row 1=y0, 2=y0.1, ..., 10=y0.9
const buildings: LabeledObject[] = [
  { label: "灯塔",       box: { x: 0.38, y: 0.01, width: 0.14, height: 0.17 } }, // E1-F2
  { label: "游船",       box: { x: 0.32, y: 0.21, width: 0.17, height: 0.10 } }, // D3-F3
  { label: "码头",       box: { x: 0.33, y: 0.28, width: 0.12, height: 0.06 } }, // D3-E3 (pier)
  { label: "咖啡馆",     box: { x: 0.40, y: 0.30, width: 0.14, height: 0.14 } }, // E4-F5
  { label: "喷泉广场",   box: { x: 0.60, y: 0.28, width: 0.13, height: 0.14 } }, // G4-H5
  { label: "民居 A",     box: { x: 0.68, y: 0.28, width: 0.10, height: 0.14 } }, // H4-I5
  { label: "民居 B",     box: { x: 0.78, y: 0.29, width: 0.09, height: 0.13 } }, // I4-J5
  { label: "游乐区",     box: { x: 0.80, y: 0.40, width: 0.09, height: 0.12 } }, // I5-J6
  { label: "机械工坊",   box: { x: 0.16, y: 0.29, width: 0.10, height: 0.16 } }, // 收紧至建筑本体 C4-D5
  { label: "超市",       box: { x: 0.08, y: 0.47, width: 0.14, height: 0.14 } }, // 收紧至建筑本体 B6-C7
  { label: "能源中心",   box: { x: 0.20, y: 0.39, width: 0.13, height: 0.15 } }, // C5-D6
  { label: "植物园",     box: { x: 0.27, y: 0.48, width: 0.12, height: 0.12 } }, // D6-E7
  { label: "医院",       box: { x: 0.41, y: 0.39, width: 0.20, height: 0.25 } }, // E5-G8
  { label: "番茄农场",   box: { x: 0.61, y: 0.40, width: 0.08, height: 0.09 } }, // G5-H6
  { label: "温室",       box: { x: 0.60, y: 0.50, width: 0.12, height: 0.13 } }, // G6-H7
  { label: "水塔",       box: { x: 0.32, y: 0.58, width: 0.11, height: 0.17 } }, // D7-E8
  { label: "城门",       box: { x: 0.61, y: 0.66, width: 0.14, height: 0.14 } }, // G8-H9
  { label: "公交站",     box: { x: 0.27, y: 0.71, width: 0.06, height: 0.07 } }, // C8-D8
];

const PALETTE = [
  "#E53935", "#1E88E5", "#43A047", "#FB8C00", "#8E24AA",
  "#00ACC1", "#F4511E", "#039BE5", "#7CB342", "#FFB300",
  "#D81B60", "#3949AB", "#00897B", "#C0CA33", "#6D4C41",
  "#F06292", "#4DB6AC", "#FFF176",
];

function pickColor(i: number) { return PALETTE[i % PALETTE.length]; }

function buildArrow(W: number, H: number, obj: LabeledObject, i: number): string {
  const { box, label } = obj;
  const px = Math.round(box.x * W), py = Math.round(box.y * H);
  const pw = Math.round(box.width * W), ph = Math.round(box.height * H);
  const cx = px + Math.round(pw * 0.5), cy = py + Math.round(ph * 0.45);
  const color = pickColor(i);

  const angle = ((i * 137) % 360) * (Math.PI / 180);
  const radius = Math.min(W, H) * 0.175;
  const rawAx = cx + Math.round(Math.cos(angle) * radius);
  const rawAy = cy + Math.round(Math.sin(angle) * radius);
  const lw = Math.max(80, label.length * 15 + 20), lh = 30;
  const ax = Math.min(Math.max(rawAx, lw / 2 + 6), W - lw / 2 - 6);
  const ay = Math.min(Math.max(rawAy, lh + 6), H - 6);

  const head = Math.max(10, Math.round(Math.min(W, H) * 0.015));
  const dx = cx - ax, dy = cy - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len, uy = dy / len;
  const tipX = cx - ux * 4, tipY = cy - uy * 4;
  const bx2 = tipX - ux * head, by2 = tipY - uy * head;
  const nx = -uy, ny = ux;
  const p1x = Math.round(bx2 + nx * head * 0.5), p1y = Math.round(by2 + ny * head * 0.5);
  const p2x = Math.round(bx2 - nx * head * 0.5), p2y = Math.round(by2 - ny * head * 0.5);
  const sw = Math.max(2, Math.round(Math.min(W, H) * 0.004));
  const lx = Math.round(ax - lw / 2), ly = Math.round(ay - lh);
  const fs2 = Math.max(13, Math.round(Math.min(W, H) * 0.018));

  return `
  <rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="5"
    fill="none" stroke="${color}" stroke-width="${sw + 1}" stroke-dasharray="8 4"/>
  <line x1="${ax}" y1="${ay}" x2="${tipX}" y2="${tipY}"
    stroke="${color}" stroke-width="${sw + 1}" stroke-linecap="round"/>
  <polygon points="${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}" fill="${color}"/>
  <rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="7"
    fill="${color}" fill-opacity="0.93"/>
  <text x="${lx + 8}" y="${ly + lh - 8}"
    font-size="${fs2}" font-family="Arial, Microsoft YaHei, sans-serif"
    fill="#FFFFFF" font-weight="bold">${label}</text>`;
}

// ─── Numbered style renderer ──────────────────────────────────────────────────

function buildNumbered(W: number, H: number, objects: LabeledObject[], legendW: number): string {
  const totalW = W + legendW;
  const badgeR = Math.max(14, Math.round(Math.min(W, H) * 0.022));
  const badgeFs = Math.max(10, badgeR - 4);
  const sw = Math.max(2, Math.round(Math.min(W, H) * 0.003));

  const boxes = objects.map((obj, i) => {
    const c = pickColor(i);
    const px = Math.round(obj.box.x * W), py = Math.round(obj.box.y * H);
    const pw = Math.round(obj.box.width * W), ph = Math.round(obj.box.height * H);
    // Center badge inside the building, not at corner
    const bx = px + Math.round(pw * 0.5);
    const by = py + Math.round(ph * 0.45);
    return `
  <rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="4"
    fill="rgba(0,0,0,0.04)" stroke="${c}" stroke-width="${sw + 1}" stroke-dasharray="7 3"/>
  <circle cx="${bx}" cy="${by}" r="${badgeR}" fill="${c}"/>
  <text x="${bx}" y="${by + badgeFs * 0.38}" text-anchor="middle"
    font-size="${badgeFs}" font-family="Arial, sans-serif" fill="#FFF" font-weight="bold">${i + 1}</text>`;
  });

  const lfs = Math.max(13, Math.round(Math.min(W, H) * 0.018));
  const sr = Math.max(10, Math.round(lfs * 0.65));
  const topPad = 28;
  const avail = H - topPad - 12;
  const entryH = Math.min(sr * 2 + 14, Math.max(sr * 2 + 8, Math.floor(avail / objects.length)));
  const lx = W + 10;

  const items = objects.map((obj, i) => {
    const c = pickColor(i);
    const cy = topPad + i * entryH + sr;
    return `
  <circle cx="${lx + sr}" cy="${cy}" r="${sr}" fill="${c}"/>
  <text x="${lx + sr}" y="${cy + sr * 0.42}" text-anchor="middle"
    font-size="${Math.max(9, sr - 3)}" font-family="Arial" fill="#FFF" font-weight="bold">${i + 1}</text>
  <text x="${lx + sr * 2 + 8}" y="${cy + lfs * 0.38}"
    font-size="${lfs}" font-family="Arial, Microsoft YaHei" fill="#222">${obj.label}</text>`;
  });

  return `<svg width="${totalW}" height="${H}" viewBox="0 0 ${totalW} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${W}" y="0" width="${legendW}" height="${H}" fill="#F5F5F5"/>
  <line x1="${W + 0.5}" y1="0" x2="${W + 0.5}" y2="${H}" stroke="#CCC" stroke-width="1"/>
  <text x="${W + legendW / 2}" y="18" text-anchor="middle"
    font-size="12" font-family="Arial" fill="#888" font-weight="bold">图 例</text>
${boxes.join("")}
${items.join("")}
</svg>`;
}

// ─── Grid overlay ─────────────────────────────────────────────────────────────

function buildGridSvg(W: number, H: number): string {
  const cols = 10, rows = 10;
  const COLS = "ABCDEFGHIJ".split("");
  const cw = W / cols, ch = H / rows;
  const lines: string[] = [];
  for (let c = 0; c <= cols; c++) {
    const x = Math.round(c * cw);
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="rgba(40,40,40,0.45)" stroke-width="1"/>`);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.round(r * ch);
    lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(40,40,40,0.45)" stroke-width="1"/>`);
  }
  const labels: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round(c * cw + 2), y = Math.round(r * ch + 13);
      const lbl = `${COLS[c]}${r + 1}`;
      labels.push(
        `<rect x="${x - 1}" y="${y - 12}" width="${lbl.length * 5 + 4}" height="14" fill="rgba(255,255,255,0.65)" rx="2"/>` +
        `<text x="${x}" y="${y}" font-size="10" font-family="Arial,monospace" fill="rgba(15,15,15,0.9)">${lbl}</text>`
      );
    }
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${lines.join("")}${labels.join("")}</svg>`;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  const imgPath = path.resolve("input/20260331-210043.jpg");
  await fs.mkdir(path.resolve("output"), { recursive: true });

  const buf = await fs.readFile(imgPath);
  const meta = await sharp(buf).metadata();
  const W = meta.width!, H = meta.height!;

  // ── 1. Arrow style ────────────────────────────────────────────────────────
  {
    const outPath = path.resolve("output/city_arrow_v3.png");
    const frags = buildings.map((b, i) => buildArrow(W, H, b, i));
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
${frags.join("\n")}
</svg>`;
    await sharp(buf).composite([{ input: Buffer.from(svg) }]).png().toFile(outPath);
    console.log(`[arrow]    → ${outPath}`);
  }

  // ── 2. Numbered style ─────────────────────────────────────────────────────
  {
    const outPath = path.resolve("output/city_numbered_v4.png");
    const maxLen = Math.max(...buildings.map(b => b.label.length));
    const legendW = Math.max(160, maxLen * 14 + 80);
    const extBuf = await sharp(buf)
      .extend({ right: legendW, background: { r: 245, g: 245, b: 245, alpha: 255 } })
      .toBuffer();
    const svg = buildNumbered(W, H, buildings, legendW);
    await sharp(extBuf).composite([{ input: Buffer.from(svg) }]).png().toFile(outPath);
    console.log(`[numbered] → ${outPath}`);
  }

  // ── 3. Grid overlay preview (Path A diagnostic) ───────────────────────────
  {
    const outPath = path.resolve("output/city_grid_preview.jpg");
    const gridSvg = buildGridSvg(W, H);
    await sharp(buf)
      .composite([{ input: Buffer.from(gridSvg) }])
      .jpeg({ quality: 90 })
      .toFile(outPath);
    console.log(`[grid]     → ${outPath}`);
  }

  console.log(`\nBuildings: ${buildings.length}`);
}

run().catch(e => { console.error(e); process.exit(1); });
