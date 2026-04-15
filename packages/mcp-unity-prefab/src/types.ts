export interface PrefabAssetInfo {
  path: string;
  guid: string;
  assetType: string;
  name: string;
  fileName: string;
  isFolder: boolean;
  lastWriteTimeUtc?: string;
  previewBase64?: string;
  previewWidth: number;
  previewHeight: number;
}

export interface PrefabInfoData {
  assetPath: string;
  guid: string;
  prefabType: string;
  rootObjectName: string;
  rootComponentTypes: string[];
  childCount: number;
  isVariant: boolean;
  parentPrefab?: string | null;
}

export interface PrefabRecord {
  name: string;
  path: string;
  guid: string;
  fileName: string;
  assetType: string;
  prefabType: string;
  rootObjectName: string;
  rootComponentTypes: string[];
  childCount: number;
  isVariant: boolean;
  parentPrefab?: string | null;
  lastWriteTimeUtc?: string;
  previewBase64?: string;
  previewWidth: number;
  previewHeight: number;
}

export interface PrefabFolderMemoryRecord {
  key: string;
  folderPath: string;
  host: string;
  port: number;
  unityInstance?: string;
  createdAt: string;
  updatedAt: string;
  prefabs: PrefabRecord[];
  sheetPath?: string;
}
