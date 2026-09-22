import fs from 'node:fs';

import { sniffImageMimeType } from './sticker-media-cache.js';

const DEFAULT_MAX_CARD_IMAGE_SIZE = 20 * 1024 * 1024;

export interface FeishuCardImageFileInspection {
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (offset + 7 > buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function readImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === 'image/jpeg') return readJpegDimensions(buffer);
  if (mimeType === 'image/webp' && buffer.length >= 30) {
    const kind = buffer.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (kind === 'VP8L' && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

/**
 * 卡片图片上传前的本地真实性门禁：普通文件、非符号链接、受支持文件头、
 * 可解析尺寸和大小上限缺一不可，避免把扩展名伪装文件送进飞书 CardKit。
 */
export function inspectFeishuCardImageFile(
  filePath: string,
  maxSize = DEFAULT_MAX_CARD_IMAGE_SIZE,
): FeishuCardImageFileInspection | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxSize) return null;
    const buffer = fs.readFileSync(filePath);
    const sniffed = sniffImageMimeType(buffer);
    if (!sniffed) return null;
    const dimensions = readImageDimensions(buffer, sniffed.mimeType);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
    return { ...dimensions, mimeType: sniffed.mimeType, size: stat.size };
  } catch {
    return null;
  }
}
