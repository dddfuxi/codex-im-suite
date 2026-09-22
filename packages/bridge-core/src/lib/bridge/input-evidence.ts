export const INPUT_EVIDENCE_PROTOCOL = 'cti-input-evidence/v1' as const;

export type InputEvidenceKind = 'image' | 'audio' | 'video' | 'file';

export interface InputEvidenceFileLike {
  id: string;
  type: string;
}

export interface InputEvidenceDescriptor {
  id: string;
  kind: InputEvidenceKind;
  mediaType: string;
}

export interface ProviderInputEvidenceReceipt {
  protocol: typeof INPUT_EVIDENCE_PROTOCOL;
  provider: string;
  accepted: InputEvidenceDescriptor[];
}

export function classifyInputEvidenceKind(mediaType: string): InputEvidenceKind {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  return 'file';
}

export function describeInputEvidence(files?: InputEvidenceFileLike[]): InputEvidenceDescriptor[] {
  return (files || [])
    .filter((file) => !!file.id?.trim() && !!file.type?.trim())
    .map((file) => ({
      id: file.id.trim(),
      kind: classifyInputEvidenceKind(file.type),
      mediaType: file.type.trim().toLowerCase(),
    }));
}

export function buildProviderInputEvidenceReceipt(
  files: InputEvidenceFileLike[] | undefined,
  provider: string,
  acceptedKinds?: InputEvidenceKind[],
): ProviderInputEvidenceReceipt | null {
  const allowedKinds = acceptedKinds?.length ? new Set(acceptedKinds) : null;
  const accepted = describeInputEvidence(files)
    .filter((item) => !allowedKinds || allowedKinds.has(item.kind));
  if (accepted.length === 0) return null;
  return {
    protocol: INPUT_EVIDENCE_PROTOCOL,
    provider: provider.trim() || 'unknown',
    accepted,
  };
}

export function parseProviderInputEvidenceReceipt(value: unknown): ProviderInputEvidenceReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.protocol !== INPUT_EVIDENCE_PROTOCOL || typeof record.provider !== 'string') return null;
  if (!Array.isArray(record.accepted)) return null;

  const accepted = record.accepted.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const descriptor = item as Record<string, unknown>;
    const id = typeof descriptor.id === 'string' ? descriptor.id.trim() : '';
    const kind = descriptor.kind;
    const mediaType = typeof descriptor.mediaType === 'string' ? descriptor.mediaType.trim().toLowerCase() : '';
    if (!id || !mediaType || (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'file')) return [];
    return [{ id, kind, mediaType } as InputEvidenceDescriptor];
  });
  if (accepted.length === 0) return null;
  return {
    protocol: INPUT_EVIDENCE_PROTOCOL,
    provider: record.provider.trim() || 'unknown',
    accepted,
  };
}
