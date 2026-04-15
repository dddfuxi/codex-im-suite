export interface AppConfig {
  unityMcpHost: string;
  unityMcpPort: number;
  unityMcpTimeoutMs: number;
  unityInstance?: string;
  memoryDir: string;
  outputDir: string;
  defaultColumns: number;
  defaultPageSize: number;
  previewWidth: number;
  previewHeight: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function normalizeUnityAssetPath(raw: string): string {
  const normalized = raw.trim().replace(/\\/g, "/");
  if (!normalized) throw new Error("folder_path is required");
  if (normalized === "Assets" || normalized.startsWith("Assets/")) {
    return normalized;
  }

  const embeddedAssetsIndex = normalized.indexOf("/Assets/");
  if (embeddedAssetsIndex >= 0) {
    return normalized.slice(embeddedAssetsIndex + 1);
  }

  throw new Error("folder_path must be a Unity asset path like Assets/Prefabs");
}

export function loadConfig(): AppConfig {
  return {
    unityMcpHost: process.env.UNITY_MCP_HOST?.trim() || "127.0.0.1",
    unityMcpPort: parsePositiveInt(process.env.UNITY_MCP_HTTP_PORT, 8080),
    unityMcpTimeoutMs: parsePositiveInt(process.env.UNITY_MCP_TIMEOUT_MS, 30000),
    unityInstance: process.env.UNITY_MCP_INSTANCE?.trim() || undefined,
    memoryDir: process.env.UNITY_PREFAB_MEMORY_DIR?.trim() || ".unity-prefab-memory",
    outputDir: process.env.UNITY_PREFAB_OUTPUT_DIR?.trim() || "output",
    defaultColumns: parsePositiveInt(process.env.UNITY_PREFAB_COLUMNS, 4),
    defaultPageSize: parsePositiveInt(process.env.UNITY_PREFAB_PAGE_SIZE, 100),
    previewWidth: parsePositiveInt(process.env.UNITY_PREFAB_PREVIEW_WIDTH, 256),
    previewHeight: parsePositiveInt(process.env.UNITY_PREFAB_PREVIEW_HEIGHT, 256),
  };
}
