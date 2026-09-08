import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractCtiPanelSettingsAction } from '../../lib/bridge/application/action-blocks.js';
import {
  buildPanelSettingsEvidencePrompt,
  formatPanelSettingsSnapshot,
  resolvePanelSettingsIntent,
} from '../../lib/bridge/application/panel-settings-policy.js';

const snapshot = {
  protocol: 'cti-panel-settings-snapshot/v1' as const,
  version: 'version-1',
  generatedAt: '2026-08-11T00:00:00.000Z',
  settings: [
    { key: 'replyStyleHint', label: '回复风格', group: '回复与执行', type: 'string' as const, writable: true, restartRequired: true, value: '简洁' },
    { key: 'codexApiKeySet', label: 'Codex API Key', group: 'Codex', type: 'secret_status' as const, writable: false, restartRequired: true, value: true },
  ],
};

describe('bridge panel settings protocol', () => {
  it('recognizes general list and update intents without depending on one fixed sentence', () => {
    assert.equal(resolvePanelSettingsIntent('把面板里的回复风格调整成更简洁'), 'update');
    assert.equal(resolvePanelSettingsIntent('现在机器人配置有哪些，列给我'), 'list');
    assert.equal(resolvePanelSettingsIntent('今天天气如何'), null);
  });

  it('parses only bounded scalar changes and rejects identity or env fields', () => {
    const valid = extractCtiPanelSettingsAction([
      '```cti-panel-settings',
      JSON.stringify({ action: 'update', expectedVersion: 'version-1', changes: [{ key: 'replyStyleHint', value: '详细' }] }),
      '```',
    ].join('\n'));
    assert.deepEqual(valid.action?.changes, [{ key: 'replyStyleHint', value: '详细' }]);

    const invalid = extractCtiPanelSettingsAction([
      '```cti-panel-settings',
      JSON.stringify({ action: 'update', owner: 'fake', changes: [{ key: 'CTI_REPLY_STYLE_HINT', value: '详细' }] }),
      '```',
    ].join('\n'));
    assert.equal(invalid.action, null);
    assert.match(invalid.error || '', /不允许字段/u);
  });

  it('shows secret status without exposing a secret value', () => {
    const evidence = buildPanelSettingsEvidencePrompt(snapshot);
    const visible = formatPanelSettingsSnapshot(snapshot);
    assert.match(evidence, /cti-panel-settings-evidence\/v1/u);
    assert.match(evidence, /已配置/u);
    assert.match(visible, /Codex API Key：已配置/u);
    assert.equal(evidence.includes('token'), true); // policy mentions the forbidden field family, not a value.
  });
});
