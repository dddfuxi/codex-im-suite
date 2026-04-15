import type { AppConfig } from "./config";
import { normalizeUnityAssetPath } from "./config";
import type { PrefabAssetInfo, PrefabInfoData } from "./types";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unity MCP returned an unexpected payload");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function extractError(payload: Record<string, unknown>): string {
  return (
    asString(payload.error) ||
    asString(payload.message) ||
    "Unity MCP returned an unknown error"
  );
}

function unwrapUnityEnvelope<T>(input: unknown): T {
  let current = input;
  for (let depth = 0; depth < 6; depth += 1) {
    const payload = asObject(current);
    if (payload.success === false) {
      throw new Error(extractError(payload));
    }
    if (payload.result !== undefined) {
      current = payload.result;
      continue;
    }
    if (payload.data !== undefined) {
      current = payload.data;
      continue;
    }
    return current as T;
  }
  return current as T;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (!rawText.trim()) return {};
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`Unity MCP returned non-JSON content: ${rawText.slice(0, 300)}`);
  }
}

async function sendUnityCommand(
  cfg: AppConfig,
  commandType: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(
    `http://${cfg.unityMcpHost}:${cfg.unityMcpPort}/api/command`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: commandType,
        params,
        ...(cfg.unityInstance ? { unity_instance: cfg.unityInstance } : {}),
      }),
      signal: AbortSignal.timeout(cfg.unityMcpTimeoutMs),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unity MCP request failed with HTTP ${response.status}: ${body}`);
  }

  const payload = await parseJsonResponse(response);
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (root?.success === false) {
    throw new Error(extractError(root));
  }
  return payload;
}

function parsePrefabAssetInfo(payload: unknown): PrefabAssetInfo {
  const data = asObject(payload);
  return {
    path: asString(data.path),
    guid: asString(data.guid),
    assetType: asString(data.assetType),
    name: asString(data.name),
    fileName: asString(data.fileName),
    isFolder: asBoolean(data.isFolder),
    lastWriteTimeUtc: asString(data.lastWriteTimeUtc) || undefined,
    previewBase64: asString(data.previewBase64) || undefined,
    previewWidth: asNumber(data.previewWidth),
    previewHeight: asNumber(data.previewHeight),
  };
}

function parsePrefabInfo(payload: unknown): PrefabInfoData {
  const data = asObject(payload);
  const rootComponentTypes = Array.isArray(data.rootComponentTypes)
    ? data.rootComponentTypes.filter((item): item is string => typeof item === "string")
    : [];

  return {
    assetPath: asString(data.assetPath),
    guid: asString(data.guid),
    prefabType: asString(data.prefabType),
    rootObjectName: asString(data.rootObjectName),
    rootComponentTypes,
    childCount: asNumber(data.childCount),
    isVariant: asBoolean(data.isVariant),
    parentPrefab: asString(data.parentPrefab) || undefined,
  };
}

export async function searchPrefabAssets(
  cfg: AppConfig,
  folderPath: string,
  pageSize: number,
  pageNumber: number
): Promise<{
  totalAssets: number;
  pageSize: number;
  pageNumber: number;
  assets: PrefabAssetInfo[];
}> {
  const normalizedFolderPath = normalizeUnityAssetPath(folderPath);
  const payload = await sendUnityCommand(cfg, "manage_asset", {
    action: "search",
    path: normalizedFolderPath,
    // Unity AssetDatabase.FindAssets does not interpret "*.prefab" the way a filesystem glob does.
    // Use a broad token plus t:Prefab so searches are resolved by Unity's asset index.
    searchPattern: "*",
    filterType: "Prefab",
    pageSize,
    pageNumber,
  });
  const data = unwrapUnityEnvelope<{
    totalAssets?: unknown;
    pageSize?: unknown;
    pageNumber?: unknown;
    assets?: unknown;
  }>(payload);

  const assets = Array.isArray(data.assets) ? data.assets.map(parsePrefabAssetInfo) : [];
  return {
    totalAssets: asNumber(data.totalAssets, assets.length),
    pageSize: asNumber(data.pageSize, pageSize),
    pageNumber: asNumber(data.pageNumber, pageNumber),
    assets,
  };
}

export async function getPrefabAssetInfoWithPreview(
  cfg: AppConfig,
  prefabPath: string
): Promise<PrefabAssetInfo> {
  const normalizedPrefabPath = normalizeUnityAssetPath(prefabPath);
  const payload = await sendUnityCommand(cfg, "manage_asset", {
    action: "get_info",
    path: normalizedPrefabPath,
    generatePreview: true,
  });
  return parsePrefabAssetInfo(unwrapUnityEnvelope(payload));
}

export async function getPrefabInfo(
  cfg: AppConfig,
  prefabPath: string
): Promise<PrefabInfoData> {
  const normalizedPrefabPath = normalizeUnityAssetPath(prefabPath);
  const payload = await sendUnityCommand(cfg, "manage_prefabs", {
    action: "get_info",
    prefabPath: normalizedPrefabPath,
  });
  return parsePrefabInfo(unwrapUnityEnvelope(payload));
}
