export type ArtifactSourceKind = 'tool_result' | 'provider_output' | 'manual_import';

export interface ArtifactSource {
  kind: ArtifactSourceKind;
  toolUseId?: string;
  toolName?: string;
}

export interface TurnArtifactRecord {
  id: string;
  sessionId: string;
  turnId: string;
  fileName: string;
  relativePath: string;
  filePath: string;
  mediaType?: string;
  sizeBytes: number;
  sha256: string;
  source: ArtifactSource;
  createdAt: string;
}

export interface TurnArtifactManifestV1 {
  schema: 'codex-im-suite/turn-artifacts/v1';
  sessionId: string;
  turnId: string;
  generatedAt: string;
  artifacts: TurnArtifactRecord[];
}

export interface ArtifactPromotionRequest {
  artifactId: string;
  targetProjectId: string;
  targetRelativePath: string;
  expectedSha256?: string;
}

export interface ArtifactPromotionResult {
  ok: true;
  artifactId: string;
  targetProjectId: string;
  targetPath: string;
  sha256: string;
  promotedAt: string;
}

const ARTIFACT_ID_RE = /^artifact-[a-f0-9]{24}$/u;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/u;

function requireString(value: unknown, error: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(error);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(error);
  return normalized;
}

export function normalizeArtifactTargetRelativePath(value: unknown): string {
  const raw = requireString(value, 'invalid_artifact_target_path', 1024).replace(/\\/gu, '/');
  if (WINDOWS_ABSOLUTE_RE.test(raw) || raw.startsWith('/') || raw.includes('\0')) {
    throw new Error('invalid_artifact_target_path');
  }
  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('invalid_artifact_target_path');
  }
  return segments.join('/');
}

export function parseArtifactPromotionRequest(value: unknown): ArtifactPromotionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_artifact_promotion_request');
  const record = value as Record<string, unknown>;
  const artifactId = requireString(record.artifactId, 'invalid_artifact_id', 64);
  if (!ARTIFACT_ID_RE.test(artifactId)) throw new Error('invalid_artifact_id');
  const targetProjectId = requireString(record.targetProjectId, 'invalid_artifact_project_id', 64);
  if (!PROJECT_ID_RE.test(targetProjectId)) throw new Error('invalid_artifact_project_id');
  const targetRelativePath = normalizeArtifactTargetRelativePath(record.targetRelativePath);
  const expectedSha256 = record.expectedSha256 === undefined
    ? undefined
    : requireString(record.expectedSha256, 'invalid_artifact_sha256', 64).toLowerCase();
  if (expectedSha256 && !SHA256_RE.test(expectedSha256)) throw new Error('invalid_artifact_sha256');
  return {
    artifactId,
    targetProjectId,
    targetRelativePath,
    ...(expectedSha256 ? { expectedSha256 } : {}),
  };
}
