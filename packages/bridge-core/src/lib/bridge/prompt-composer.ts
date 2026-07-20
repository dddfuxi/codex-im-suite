export type PromptSectionKind =
  | 'identity'
  | 'base'
  | 'policy'
  | 'skills'
  | 'memory'
  | 'expression'
  | 'style'
  | 'protocol'
  | 'priority_context'
  | 'execution';

export interface PromptSection {
  id: string;
  kind: PromptSectionKind;
  source: string;
  priority: number;
  content: string;
  injected?: boolean;
}

export interface ComposedBridgePrompt {
  sections: PromptSection[];
  text: string;
}

export interface BridgePromptInput {
  identity?: string;
  base?: string;
  policy?: string;
  skills?: string;
  memory?: string;
  style?: string;
  protocol?: string;
}

const CANONICAL_KINDS: Array<keyof BridgePromptInput> = ['identity', 'base', 'policy', 'skills', 'memory', 'style', 'protocol'];

export function composePromptSections(sections: readonly PromptSection[]): ComposedBridgePrompt {
  const normalized = sections.flatMap((section) => {
    const content = section.content.trim();
    return content ? [{ ...section, content, injected: section.injected !== false }] : [];
  });
  return { sections: normalized, text: normalized.map((section) => section.content).join('\n\n') };
}

export function composeBridgePrompt(input: BridgePromptInput): ComposedBridgePrompt {
  return composePromptSections(CANONICAL_KINDS.map((kind, index) => ({
    id: kind,
    kind,
    source: `bridge.${kind}`,
    priority: index + 1,
    content: input[kind] || '',
  })));
}
