import fs from "node:fs/promises";
import path from "node:path";

export type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type ParsedImageInput =
  | { kind: "url"; url: string }
  | { kind: "base64"; data: string; mediaType: MediaType }
  | { kind: "path"; filePath: string };

const IMAGE_EXT_TO_MEDIA: Record<string, MediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function parseImageInput(input: {
  image_url?: string;
  image_base64?: string;
  image_path?: string;
}): { ok: true; value: ParsedImageInput } | { ok: false; error: string } {
  const url = input.image_url?.trim();
  const b64 = input.image_base64;
  const imagePath = input.image_path?.trim();

  const count = Number(Boolean(url)) + Number(Boolean(String(b64 || "").trim())) + Number(Boolean(imagePath));
  if (count > 1) {
    return { ok: false, error: "Provide only one of image_url, image_base64, image_path" };
  }
  if (count === 0) {
    return { ok: false, error: "image_url or image_base64 or image_path is required" };
  }

  if (url) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: "image_url must be http(s)" };
    return { ok: true, value: { kind: "url", url } };
  }

  if (imagePath) {
    const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(process.cwd(), imagePath);
    return { ok: true, value: { kind: "path", filePath: resolved } };
  }

  const raw = String(b64).trim();
  const cleaned = raw.replace(/\s/g, "");
  const dataUrl = /^data:image\/(jpeg|jpg|png|gif|webp);base64,(.+)$/i.exec(cleaned);
  if (dataUrl) {
    const ext = dataUrl[1].toLowerCase();
    const mediaType: MediaType =
      ext === "png"
        ? "image/png"
        : ext === "gif"
          ? "image/gif"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";
    return { ok: true, value: { kind: "base64", data: dataUrl[2], mediaType } };
  }

  return { ok: true, value: { kind: "base64", data: cleaned, mediaType: "image/jpeg" } };
}

export async function readPathImageAsBase64(filePath: string): Promise<{ data: string; mediaType: MediaType }> {
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = IMAGE_EXT_TO_MEDIA[ext];
  if (!mediaType) {
    throw new Error("image_path extension not supported, use jpg/jpeg/png/gif/webp");
  }
  const buf = await fs.readFile(filePath);
  return { data: buf.toString("base64"), mediaType };
}
