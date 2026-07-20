export type BridgeCharacterizationDomain =
  | 'inbound'
  | 'permission'
  | 'reminder'
  | 'direct_message'
  | 'history'
  | 'sticker'
  | 'attachment'
  | 'card'
  | 'artifact'
  | 'delivery';

export interface BridgeCharacterizationEntry {
  domain: BridgeCharacterizationDomain;
  testFile: string;
  testTitle: string;
}

/**
 * Task 8 渐进拆分的最低行为护栏。
 * 目录只引用真实执行的回归测试，不复制实现，也不把测试标题当运行时协议。
 */
export const BRIDGE_CHARACTERIZATION_CATALOG: readonly BridgeCharacterizationEntry[] = [
  {
    domain: 'inbound',
    testFile: 'bridge-feishu-adapter.test.ts',
    testTitle: 'enqueues accepted text before slow chat and history evidence is prepared',
  },
  {
    domain: 'permission',
    testFile: 'bridge-permission-safety.test.ts',
    testTitle: 'requires owner before an operator can approve a high-risk permission card',
  },
  {
    domain: 'reminder',
    testFile: 'bridge-manager.test.ts',
    testTitle: 'executes cti-reminder through the real reminder host and only sends the host result',
  },
  {
    domain: 'direct_message',
    testFile: 'bridge-manager.test.ts',
    testTitle: 'executes cti-direct-message through the channel adapter and only confirms in the source chat',
  },
  {
    domain: 'history',
    testFile: 'bridge-feishu-adapter.test.ts',
    testTitle: 'recognizes upward message references as cloud history intent instead of light context',
  },
  {
    domain: 'sticker',
    testFile: 'bridge-manager.test.ts',
    testTitle: 'records visually analyzed sticker candidates and sends the selected one for generic sticker requests',
  },
  {
    domain: 'attachment',
    testFile: 'conversation-engine.test.ts',
    testTitle: 'stages transient IM attachments in runtime upload cache instead of workspace',
  },
  {
    domain: 'card',
    testFile: 'bridge-feishu-adapter.test.ts',
    testTitle: 'persists original task and final result for a finalized streaming card',
  },
  {
    domain: 'artifact',
    testFile: 'bridge-manager.test.ts',
    testTitle: 'promotes a managed artifact only for an explicit owner project-write request',
  },
  {
    domain: 'delivery',
    testFile: 'bridge-manager.test.ts',
    testTitle: 'delivers cti-final markdown through the Feishu outbound path as markdown',
  },
];
