import fs from 'node:fs';
import path from 'node:path';

import { MemoryArtifactStore } from '../../../memory-artifact-store.js';
import type { FileAttachment } from '../../../types.js';

const STICKER_MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

export interface PersistedStickerMedia {
  attachment: FileAttachment;
  mimeType: string;
  size: number;
}

export function sniffImageMimeType(buffer: Buffer): { mimeType: string; extension: string } | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function mimeTypeForExtension(extension: string): string | null {
  switch (extension.toLowerCase().replace(/^\./u, '')) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return null;
  }
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('webp')) return 'webp';
  return 'png';
}

export class FeishuStickerMediaCache {
  private readonly maxFileSize: number;

  constructor(
    readonly mediaDirectory: string,
    options: { maxFileSize?: number } = {},
  ) {
    this.mediaDirectory = path.resolve(mediaDirectory);
    this.maxFileSize = Math.max(1, Math.floor(options.maxFileSize ?? 20 * 1024 * 1024));
  }

  pathFor(fileKey: string, extension = '.png'): string {
    const normalized = extension.toLowerCase().startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    const safeExtension = STICKER_MEDIA_EXTENSIONS.includes(normalized as typeof STICKER_MEDIA_EXTENSIONS[number])
      ? normalized
      : '.png';
    return path.join(this.mediaDirectory, MemoryArtifactStore.stableFileName(fileKey, safeExtension));
  }

  findPath(fileKey: string): string | null {
    if (!fileKey.trim()) return null;
    for (const extension of STICKER_MEDIA_EXTENSIONS) {
      const candidate = this.pathFor(fileKey, extension);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  read(fileKey: string): FileAttachment | null {
    try {
      const cachePath = this.findPath(fileKey);
      if (!cachePath) return null;
      const stat = fs.statSync(cachePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxFileSize) return null;
      const buffer = fs.readFileSync(cachePath);
      const sniffed = sniffImageMimeType(buffer);
      const fallbackExtension = path.extname(cachePath).replace(/^\./u, '').toLowerCase() || 'png';
      const mimeType = sniffed?.mimeType || mimeTypeForExtension(fallbackExtension) || 'image/png';
      const extension = sniffed?.extension || extensionForMimeType(mimeType);
      return {
        id: fileKey,
        name: `sticker-${fileKey}.${extension}`,
        type: mimeType,
        size: buffer.length,
        data: buffer.toString('base64'),
        filePath: cachePath,
      };
    } catch {
      return null;
    }
  }

  persist(fileKey: string, attachment: FileAttachment): PersistedStickerMedia | null {
    const normalizedKey = fileKey.trim();
    if (!normalizedKey || !attachment.type?.toLowerCase().startsWith('image/')) return null;
    const existing = this.read(normalizedKey);
    if (existing) return { attachment: existing, mimeType: existing.type, size: existing.size };
    let buffer: Buffer;
    try {
      buffer = Buffer.from(attachment.data || '', 'base64');
    } catch {
      return null;
    }
    if (buffer.length <= 0 || buffer.length > this.maxFileSize) return null;
    const sniffed = sniffImageMimeType(buffer);
    const mimeType = sniffed?.mimeType || attachment.type || 'image/png';
    const extension = sniffed?.extension || extensionForMimeType(mimeType);
    const cachePath = this.pathFor(normalizedKey, extension);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, buffer);
      const raced = this.read(normalizedKey);
      if (raced) return { attachment: raced, mimeType: raced.type, size: raced.size };
      fs.renameSync(tempPath, cachePath);
    } catch {
      const raced = this.read(normalizedKey);
      if (raced) return { attachment: raced, mimeType: raced.type, size: raced.size };
      return null;
    } finally {
      try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    }
    const cached = this.read(normalizedKey);
    return cached ? { attachment: cached, mimeType: cached.type, size: cached.size } : null;
  }
}
