import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PrefabRecord } from "./types";

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1))}…`;
}

function createHeaderSvg(width: number, folderPath: string, count: number): Buffer {
  const title = escapeXml(`Unity Prefabs | ${folderPath}`);
  const subtitle = escapeXml(`Total prefabs: ${count}`);
  const svg = `
    <svg width="${width}" height="88" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="88" rx="24" fill="#1f2937"/>
      <text x="28" y="38" fill="#f9fafb" font-size="24" font-weight="700"
        font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">${title}</text>
      <text x="28" y="66" fill="#cbd5e1" font-size="14"
        font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">${subtitle}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

function createCardSvg(cardWidth: number, cardHeight: number, index: number, prefab: PrefabRecord): Buffer {
  const title = escapeXml(truncateText(prefab.name, 24));
  const root = escapeXml(truncateText(`Root: ${prefab.rootObjectName}`, 36));
  const meta = escapeXml(
    truncateText(`${prefab.prefabType} | Children: ${prefab.childCount}`, 36)
  );
  const assetPath = escapeXml(truncateText(prefab.path, 46));
  const badge = escapeXml(String(index + 1));

  const svg = `
    <svg width="${cardWidth}" height="${cardHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="24" fill="#ffffff" stroke="#d1d5db" stroke-width="2"/>
      <rect x="18" y="18" width="${cardWidth - 36}" height="180" rx="18" fill="#f3f4f6" stroke="#e5e7eb" stroke-width="1.5"/>
      <rect x="18" y="18" width="42" height="42" rx="21" fill="#111827"/>
      <text x="39" y="45" text-anchor="middle" fill="#f9fafb" font-size="16" font-weight="700"
        font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">${badge}</text>
      <text x="22" y="228" fill="#111827" font-size="21" font-weight="700"
        font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">${title}</text>
      <text x="22" y="254" fill="#4b5563" font-size="14"
        font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">${root}</text>
      <text x="22" y="276" fill="#6b7280" font-size="13"
        font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">${meta}</text>
      <text x="22" y="298" fill="#9ca3af" font-size="11"
        font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">${assetPath}</text>
    </svg>
  `;

  return Buffer.from(svg);
}

async function createPreviewTile(prefab: PrefabRecord): Promise<Buffer> {
  const tileWidth = 248;
  const tileHeight = 156;

  if (!prefab.previewBase64) {
    const svg = `
      <svg width="${tileWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${tileWidth}" height="${tileHeight}" rx="16" fill="#e5e7eb"/>
        <text x="124" y="80" text-anchor="middle" fill="#6b7280" font-size="18" font-weight="600"
          font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif">No Preview</text>
      </svg>
    `;
    return Buffer.from(svg);
  }

  const previewBuffer = Buffer.from(prefab.previewBase64, "base64");
  return sharp({
    create: {
      width: tileWidth,
      height: tileHeight,
      channels: 4,
      background: "#f9fafb",
    },
  })
    .composite([{
      input: await sharp(previewBuffer)
        .resize({
          width: tileWidth,
          height: tileHeight,
          fit: "contain",
          background: "#f9fafb",
        })
        .png()
        .toBuffer(),
      left: 0,
      top: 0,
    }])
    .png()
    .toBuffer();
}

export async function renderPrefabSheet(input: {
  folderPath: string;
  prefabs: PrefabRecord[];
  outputPath: string;
  columns: number;
}): Promise<string> {
  const columns = Math.max(1, input.columns);
  const padding = 24;
  const gap = 18;
  const headerHeight = 88;
  const cardWidth = 284;
  const cardHeight = 320;
  const rows = Math.max(1, Math.ceil(input.prefabs.length / columns));
  const width = padding * 2 + cardWidth * columns + gap * (columns - 1);
  const height =
    padding * 2 +
    headerHeight +
    18 +
    cardHeight * rows +
    gap * Math.max(0, rows - 1);

  const composites: sharp.OverlayOptions[] = [
    {
      input: createHeaderSvg(width - padding * 2, input.folderPath, input.prefabs.length),
      top: padding,
      left: padding,
    },
  ];

  for (let index = 0; index < input.prefabs.length; index += 1) {
    const prefab = input.prefabs[index];
    const row = Math.floor(index / columns);
    const column = index % columns;
    const left = padding + column * (cardWidth + gap);
    const top = padding + headerHeight + 18 + row * (cardHeight + gap);

    composites.push({
      input: createCardSvg(cardWidth, cardHeight, index, prefab),
      left,
      top,
    });
    composites.push({
      input: await createPreviewTile(prefab),
      left: left + 18,
      top: top + 30,
    });
  }

  const outputPath = path.resolve(process.cwd(), input.outputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#efe9df",
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return outputPath;
}
