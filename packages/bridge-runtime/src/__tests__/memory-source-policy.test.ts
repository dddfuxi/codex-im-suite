import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  MEMORY_V3_SCHEMA,
  classifyMemoryV2Source,
  isVisibleMemoryV2SourceToQuery,
  memoryPartitionSegment,
} from '../memory-source-policy.js';

describe('memory source policy visible layout', () => {
  const root = path.resolve('E:\\cli-md');

  it('accepts a v3 user impression under memory/users', () => {
    const userId = 'ou_user_a';
    const source = path.join(root, 'memory', 'users', 'feishu', memoryPartitionSegment(userId), '用户印象.md');
    const result = classifyMemoryV2Source(root, source, {
      schema: MEMORY_V3_SCHEMA,
      memoryScope: 'user',
      channelType: 'feishu',
      userId,
    });

    assert.equal(result.ok, true);
    assert.equal(result.scope, 'user');
    assert.equal(result.sourceGroup, 'memory_user');
    assert.equal(result.layoutVersion, 'v3');
    assert.equal(result.legacy, false);
  });

  it('accepts v3 group and public long-term documents', () => {
    const chatId = 'oc_group_a';
    const groupSource = path.join(root, 'memory', 'groups', 'feishu', memoryPartitionSegment(chatId), '群聊记忆.md');
    const longTermSource = path.join(root, 'memory', 'long-term', '公共长期记忆.md');

    assert.equal(classifyMemoryV2Source(root, groupSource, {
      schema: MEMORY_V3_SCHEMA,
      memoryScope: 'group',
      channelType: 'feishu',
      chatId,
    }).ok, true);
    assert.equal(classifyMemoryV2Source(root, longTermSource, {
      schema: MEMORY_V3_SCHEMA,
      memoryScope: 'long_term',
    }).ok, true);
  });

  it('keeps legacy v2 files indexable but marks them as legacy', () => {
    const source = path.join(root, 'data', 'memory', 'v2', 'long-term', 'notes.md');
    const result = classifyMemoryV2Source(root, source, {
      schema: 'codex-im-suite/memory/v2',
      memoryScope: 'long_term',
    });

    assert.equal(result.ok, true);
    assert.equal(result.layoutVersion, 'v2');
    assert.equal(result.legacy, true);
  });

  it('isolates v3 user impressions by verified user id', () => {
    const source = path.join(root, 'memory', 'users', 'feishu', 'ou_user_a', '用户印象.md');
    const metadata = {
      schema: MEMORY_V3_SCHEMA,
      memoryScope: 'user',
      channelType: 'feishu',
      userId: 'ou_user_a',
    };

    assert.equal(isVisibleMemoryV2SourceToQuery(root, source, metadata, {
      channelType: 'feishu',
      userId: 'ou_user_a',
    }), true);
    assert.equal(isVisibleMemoryV2SourceToQuery(root, source, metadata, {
      channelType: 'feishu',
      userId: 'ou_user_b',
    }), false);
  });
});
