import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import { normalizeUnityAssetPath } from "./config";
import type { PrefabFolderMemoryRecord, PrefabRecord } from "./types";

function buildMemoryKey(cfg: AppConfig, folderPath: string): string {
  const fingerprint = [
    cfg.unityMcpHost,
    String(cfg.unityMcpPort),
    cfg.unityInstance ?? "",
    folderPath,
  ].join("|");
  return crypto.createHash("sha256").update(fingerprint).digest("hex");
}

function getMemoryPath(cfg: AppConfig, key: string): string {
  return path.resolve(process.cwd(), cfg.memoryDir, `${key}.json`);
}

export async function loadPrefabFolderMemory(
  cfg: AppConfig,
  folderPath: string
): Promise<PrefabFolderMemoryRecord | null> {
  const normalizedFolderPath = normalizeUnityAssetPath(folderPath);
  const key = buildMemoryKey(cfg, normalizedFolderPath);
  try {
    const raw = await fs.readFile(getMemoryPath(cfg, key), "utf8");
    return JSON.parse(raw) as PrefabFolderMemoryRecord;
  } catch {
    return null;
  }
}

export async function savePrefabFolderMemory(
  cfg: AppConfig,
  input: {
    folderPath: string;
    prefabs: PrefabRecord[];
    sheetPath?: string;
  }
): Promise<PrefabFolderMemoryRecord> {
  const normalizedFolderPath = normalizeUnityAssetPath(input.folderPath);
  const key = buildMemoryKey(cfg, normalizedFolderPath);
  const previous = await loadPrefabFolderMemory(cfg, normalizedFolderPath);
  const now = new Date().toISOString();

  const record: PrefabFolderMemoryRecord = {
    key,
    folderPath: normalizedFolderPath,
    host: cfg.unityMcpHost,
    port: cfg.unityMcpPort,
    unityInstance: cfg.unityInstance,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    prefabs: input.prefabs,
    ...(input.sheetPath
      ? { sheetPath: path.resolve(process.cwd(), input.sheetPath) }
      : previous?.sheetPath
        ? { sheetPath: previous.sheetPath }
        : {}),
  };

  const memoryDir = path.resolve(process.cwd(), cfg.memoryDir);
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(getMemoryPath(cfg, key), JSON.stringify(record, null, 2), "utf8");
  return record;
}
