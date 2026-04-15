import path from "node:path";
import type { AppConfig } from "./config";
import { normalizeUnityAssetPath } from "./config";
import { loadPrefabFolderMemory, savePrefabFolderMemory } from "./memory";
import { renderPrefabSheet } from "./render-sheet";
import type { PrefabAssetInfo, PrefabFolderMemoryRecord, PrefabRecord } from "./types";
import { getPrefabAssetInfoWithPreview, getPrefabInfo, searchPrefabAssets } from "./unity-mcp-http";

function slugifyFolderPath(folderPath: string): string {
  return folderPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  iteratee: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function fetchAllPrefabAssets(
  cfg: AppConfig,
  folderPath: string,
  pageSize: number
): Promise<PrefabAssetInfo[]> {
  const assets: PrefabAssetInfo[] = [];
  let pageNumber = 1;
  let totalAssets = Number.POSITIVE_INFINITY;

  while (assets.length < totalAssets) {
    const page = await searchPrefabAssets(cfg, folderPath, pageSize, pageNumber);
    assets.push(...page.assets);
    totalAssets = page.totalAssets;
    if (page.assets.length === 0) break;
    pageNumber += 1;
  }

  return assets;
}

async function enrichPrefab(cfg: AppConfig, asset: PrefabAssetInfo): Promise<PrefabRecord> {
  const [prefabInfo, previewInfo] = await Promise.all([
    getPrefabInfo(cfg, asset.path),
    getPrefabAssetInfoWithPreview(cfg, asset.path).catch(() => asset),
  ]);

  return {
    name: previewInfo.name || asset.name,
    path: previewInfo.path || asset.path,
    guid: prefabInfo.guid || previewInfo.guid || asset.guid,
    fileName: previewInfo.fileName || asset.fileName,
    assetType: previewInfo.assetType || asset.assetType,
    prefabType: prefabInfo.prefabType,
    rootObjectName: prefabInfo.rootObjectName || previewInfo.name || asset.name,
    rootComponentTypes: prefabInfo.rootComponentTypes,
    childCount: prefabInfo.childCount,
    isVariant: prefabInfo.isVariant,
    parentPrefab: prefabInfo.parentPrefab,
    lastWriteTimeUtc: previewInfo.lastWriteTimeUtc || asset.lastWriteTimeUtc,
    previewBase64: previewInfo.previewBase64,
    previewWidth: previewInfo.previewWidth,
    previewHeight: previewInfo.previewHeight,
  };
}

export async function scanUnityPrefabFolder(
  cfg: AppConfig,
  input: {
    folder_path: string;
    page_size?: number;
    force_refresh?: boolean;
  }
): Promise<{
  count: number;
  prefabs: PrefabRecord[];
  memory: PrefabFolderMemoryRecord;
  fromMemory: boolean;
}> {
  const folderPath = normalizeUnityAssetPath(input.folder_path);
  if (!input.force_refresh) {
    const existing = await loadPrefabFolderMemory(cfg, folderPath);
    if (existing) {
      return {
        count: existing.prefabs.length,
        prefabs: existing.prefabs,
        memory: existing,
        fromMemory: true,
      };
    }
  }

  const pageSize = input.page_size ?? cfg.defaultPageSize;
  const assets = await fetchAllPrefabAssets(cfg, folderPath, pageSize);
  const prefabs = await mapWithConcurrency(assets, 4, async (asset) => enrichPrefab(cfg, asset));
  prefabs.sort((left, right) => left.path.localeCompare(right.path));

  const memory = await savePrefabFolderMemory(cfg, {
    folderPath,
    prefabs,
  });

  return {
    count: prefabs.length,
    prefabs,
    memory,
    fromMemory: false,
  };
}

export async function recallUnityPrefabFolder(
  cfg: AppConfig,
  input: {
    folder_path: string;
  }
): Promise<PrefabFolderMemoryRecord | null> {
  return loadPrefabFolderMemory(cfg, input.folder_path);
}

export async function annotateUnityPrefabFolder(
  cfg: AppConfig,
  input: {
    folder_path: string;
    output_path?: string;
    columns?: number;
    page_size?: number;
    force_refresh?: boolean;
  }
): Promise<{
  outputPath: string;
  count: number;
  prefabs: PrefabRecord[];
  memory: PrefabFolderMemoryRecord;
  fromMemory: boolean;
}> {
  const folderPath = normalizeUnityAssetPath(input.folder_path);
  const scanned = await scanUnityPrefabFolder(cfg, {
    folder_path: folderPath,
    page_size: input.page_size,
    force_refresh: input.force_refresh,
  });

  if (scanned.prefabs.length === 0) {
    throw new Error(`No prefab found under ${folderPath}`);
  }

  const outputPath =
    input.output_path?.trim() ||
    path.join(cfg.outputDir, `${slugifyFolderPath(folderPath)}-prefabs.png`);

  const renderedOutputPath = await renderPrefabSheet({
    folderPath,
    prefabs: scanned.prefabs,
    outputPath,
    columns: input.columns ?? cfg.defaultColumns,
  });

  const memory = await savePrefabFolderMemory(cfg, {
    folderPath,
    prefabs: scanned.prefabs,
    sheetPath: renderedOutputPath,
  });

  return {
    outputPath: renderedOutputPath,
    count: scanned.prefabs.length,
    prefabs: scanned.prefabs,
    memory,
    fromMemory: scanned.fromMemory,
  };
}
