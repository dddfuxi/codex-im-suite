import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildKnowledgeIndexFromMarkdown,
  searchKnowledgeIndex,
} from '../knowledge-indexer.js';

const GB_MOJIBAKE_CHINESE = '\u6d93\ue15f\u6783';

function memoryV2Frontmatter(scope: 'user' | 'group' | 'long_term', extra: string[] = []): string {
  return [
    '---',
    'schema: codex-im-suite/memory/v2',
    `memoryScope: ${scope}`,
    ...extra,
    '---',
    '',
  ].join('\n');
}

function managedMemoryV2Content(): string {
  const state = {
    version: 2,
    confirmed: {
      场景映射: {
        value: '医院内部场景',
        updatedAt: '2026-07-20T10:00:00.000Z',
        confidence: 1,
        status: 'confirmed',
        sourceKind: 'explicit',
      },
    },
    candidates: {
      '暂定-abc': {
        value: 'Unity MCP 截图',
        updatedAt: '2026-07-20T10:01:00.000Z',
        confidence: 0.71,
        status: 'candidate',
        sourceKind: 'candidate_observation',
      },
    },
    evidence: [],
    deletedCandidateFingerprints: {},
  };
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  return [
    '---',
    'schema: codex-im-suite/memory/v3',
    'memoryScope: user',
    'channelType: feishu',
    'userId: ou_user_1',
    '---',
    '',
    `<!-- cti-memory-state:${encoded} -->`,
    '',
    '## 已确认事实',
    '',
    '| key | value | 置信度 | 更新时间 |',
    '| --- | --- | --- | --- |',
    '| 场景映射 | 医院内部场景 | 100% | 2026-07-20T10:00:00.000Z |',
    '',
    '## 候选记忆（不参与索引）',
    '',
    '| key | value | 置信度 | 更新时间 |',
    '| --- | --- | --- | --- |',
    '| 暂定-abc | Unity MCP 截图 | 71% | 2026-07-20T10:01:00.000Z |',
    '',
  ].join('\n');
}

describe('knowledge indexer', () => {
  it('indexes only confirmed entries from managed memory v2 documents', () => {
    const memoryRoot = 'E:\\cli-md';
    const managedFile = {
      path: path.join(memoryRoot, 'memory', 'users', 'feishu', 'ou_user_1', '用户印象.md'),
      updatedAt: '2026-07-20T10:02:00.000Z',
      content: managedMemoryV2Content(),
    };

    const index = buildKnowledgeIndexFromMarkdown({ memoryRoot, files: [managedFile] });

    assert.deepEqual(index.items.map((item) => item.key), ['场景映射']);
    assert.equal(index.items[0].confidence, 1);
    assert.equal(index.items[0].classificationSource, 'managed_state');
    assert.equal(index.stats.confirmedCount, 1);
    assert.equal(index.stats.candidateCount, 1);
    assert.equal(index.stats.legacyCount, 0);
    assert.doesNotMatch(JSON.stringify(index.items), /暂定-|Unity MCP 截图/u);
  });

  it('keeps compatible markdown parsing for unmanaged v3 documents', () => {
    const memoryRoot = 'E:\\cli-md';
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot,
      files: [{
        path: path.join(memoryRoot, 'memory', 'long-term', '人工维护.md'),
        content: [
          '---',
          'schema: codex-im-suite/memory/v3',
          'memoryScope: long_term',
          '---',
          '',
          '| key | value |',
          '| --- | --- |',
          '| 人工规则 | 保留兼容解析 |',
        ].join('\n'),
      }],
    });

    assert.equal(index.items.length, 1);
    assert.equal(index.items[0].key, '人工规则');
    assert.equal(index.stats.confirmedCount, 0);
    assert.equal(index.stats.legacyCount, 1);
  });

  it('repairs mojibake before indexing searchable knowledge', () => {
    const memoryRoot = 'E:\\cli-md';
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot,
      files: [{
        path: path.join(memoryRoot, 'data', 'memory', 'v2', 'long-term', 'notes.md'),
        updatedAt: '2026-04-30T10:00:00.000Z',
        content: `${memoryV2Frontmatter('long_term')}- 事实：HSScene 是 ${GB_MOJIBAKE_CHINESE}场景。`,
      }],
    });

    assert.equal(index.items.length, 1);
    assert.match(index.items[0].text, /中文场景/);
    assert.doesNotMatch(index.items[0].text, new RegExp(GB_MOJIBAKE_CHINESE));
    assert.equal(searchKnowledgeIndex(index, { query: '中文场景' }).length, 1);
  });

  it('indexes only v2 memory files with matching schema, scope, and identity boundary', () => {
    const memoryRoot = 'E:\\cli-md';
    const validUserFile = path.join(memoryRoot, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'project.md');
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot,
      files: [
        {
          path: validUserFile,
          updatedAt: '2026-07-13T10:00:00.000Z',
          content: [
            memoryV2Frontmatter('user', [
              'channelType: feishu',
              'userId: ou_user_1',
            ]),
            '| key | value |',
            '| --- | --- |',
            '| 部署偏好 | 先运行测试 |',
          ].join('\n'),
        },
        {
          path: path.join(memoryRoot, 'docs', 'AI_BRIDGE_CONTEXT.md'),
          updatedAt: '2026-07-13T10:00:00.000Z',
          content: '- 事实：docs 里的说明不能进入长期记忆。',
        },
        {
          path: path.join(memoryRoot, 'data', 'explicit-memories', 'legacy.md'),
          updatedAt: '2026-07-13T10:00:00.000Z',
          content: '- 事实：旧 explicit memory 不能进入长期记忆。',
        },
        {
          path: path.join(memoryRoot, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'wrong-schema.md'),
          updatedAt: '2026-07-13T10:00:00.000Z',
          content: [
            '---',
            'schema: codex-im-suite/partitioned-memory/v1',
            'memoryScope: user',
            'channelType: feishu',
            'userId: ou_user_1',
            '---',
            '',
            '| key | value |',
            '| --- | --- |',
            '| 错误旧 schema | 不应索引 |',
          ].join('\n'),
        },
        {
          path: path.join(memoryRoot, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_2', 'mismatch.md'),
          updatedAt: '2026-07-13T10:00:00.000Z',
          content: [
            memoryV2Frontmatter('user', [
              'channelType: feishu',
              'userId: ou_user_1',
            ]),
            '| key | value |',
            '| --- | --- |',
            '| 身份错位 | 不应索引 |',
          ].join('\n'),
        },
      ],
    });

    assert.equal(index.items.length, 1);
    assert.equal(index.items[0].key, '部署偏好');
    assert.equal(index.items[0].value, '先运行测试');
    assert.equal(index.items[0].source.path, validUserFile);
  });

  it('extracts markdown table rows with inferred classifications', () => {
    const memoryRoot = 'E:\\cli-md';
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot,
      files: [
        {
          path: path.join(memoryRoot, 'data', 'memory', 'v2', 'long-term', 'CodexNotes.md'),
          updatedAt: '2026-04-23T10:00:00.000Z',
          content: [
            memoryV2Frontmatter('long_term'),
            '# Codex Notes',
            '',
            '## Scene Common Names',
            '',
            '| Scene identifier | Common name |',
            '| --- | --- |',
            '| `HSScene` | 医院内部场景 |',
            '| `第十三条龙` | 雷霆龙 |',
            '| `商城展示预制体` | Assets/__ArtData/_Resources/Prefab/City3D/UIScene/PreviewDragon_Thunde.prefab |',
            '| `记忆策略` | 默认只注入 Codex，不直接回复 |',
            '| `索引风险` | 后续检查分类漂移 |',
          ].join('\n'),
        },
      ],
    });

    assert.equal(index.schema, 'codex-im-suite/knowledge-index/v1');
    assert.equal(index.items.length, 5);
    assert.equal(index.items[0].kind, 'fact');
    assert.equal(index.items[0].key, 'HSScene');
    assert.equal(index.items[0].value, '医院内部场景');
    assert.equal(index.items[0].classificationSource, 'table_inference');
    assert.equal(index.items.find((item) => item.key === '第十三条龙')?.kind, 'fact');
    assert.equal(index.items.find((item) => item.key === '商城展示预制体')?.kind, 'resource');
    assert.equal(index.items.find((item) => item.key === '记忆策略')?.kind, 'conclusion');
    assert.equal(index.items.find((item) => item.key === '索引风险')?.kind, 'todo');
    assert.match(index.items[0].source.snippet, /HSScene/);
  });

  it('does not classify scene identifier aliases or frontmatter as resources', () => {
    const memoryRoot = 'E:\\cli-md';
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot,
      files: [
        {
          path: path.join(memoryRoot, 'data', 'memory', 'v2', 'groups', 'feishu', 'oc_group_1', 'STH.md'),
          updatedAt: '2026-05-11T10:00:00.000Z',
          content: [
            '\uFEFF---',
            'schema: codex-im-suite/memory/v2',
            'memoryScope: group',
            'channelType: feishu',
            'chatId: oc_group_1',
            'createdAt: 2026-05-11T09:26:16.228Z',
            '---',
            '',
            'When asked about these scene identifiers in this project, answer with the corresponding common names:',
            '',
            '| key | value |',
            '| --- | --- |',
            '| HSScene | ?????? |',
            '| city3d_citystage_ST2H_Scene | ???? |',
            '| Timeline_ST2H_Scene_01 | timeline?? |',
          ].join('\n'),
        },
      ],
    });

    assert.equal(index.items.length, 3);
    assert.deepEqual(new Set(index.items.map((item) => item.kind)), new Set(['fact']));
    assert.equal(index.items.some((item) => item.text.includes('schema:')), false);
    assert.equal(index.items.some((item) => item.text.includes('scene identifiers')), false);
  });

  it('searches by keyword and type without requiring high-confidence evidence routing', () => {
    const memoryRoot = 'E:\\cli-md';
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot,
      files: [{
        path: path.join(memoryRoot, 'data', 'memory', 'v2', 'long-term', 'notes.md'),
        updatedAt: '2026-04-23T10:00:00.000Z',
        content: `${memoryV2Frontmatter('long_term')}- 结论：记忆命中默认只注入 Codex，不直接回复。`,
      }],
    });

    const hits = searchKnowledgeIndex(index, { query: '直接回复', kinds: ['conclusion'] });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /只注入 Codex/);
  });
});
