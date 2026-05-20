export type ExtensionTrustLevel = 'bundled' | 'trusted' | 'community' | 'untrusted';
export type ExtensionCapabilityRisk = 'low' | 'medium' | 'high';

export interface ExtensionCapabilityDeclaration {
  id: string;
  category: 'mcp' | 'skill' | 'plugin' | 'model' | 'script' | 'custom';
  risk: ExtensionCapabilityRisk;
  description: string;
  requiresCredential?: boolean;
  credentialScope?: string;
}

export interface ExtensionTrustPolicy {
  schema: 'codex-im-suite/extension-trust-policy/v1';
  extensionId: string;
  trustLevel: ExtensionTrustLevel;
  sourceUrl?: string;
  sha256?: string;
  signature?: string;
  capabilities: ExtensionCapabilityDeclaration[];
  installedBy?: string;
  reviewedAt?: string;
}
