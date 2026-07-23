import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChoicePromptRegistry,
  buildChoiceSelectionText,
  parseChoicePrompt,
} from '../../lib/bridge/application/choice-prompts.js';
import { prepareDeliveryCandidate } from '../../lib/bridge/application/delivery-preparation.js';
import { buildFeishuChoiceCard } from '../../lib/bridge/channels/feishu/cards/choice-card.js';

describe('structured choice prompts', () => {
  it('accepts only a finite set of visible options from cti-final', () => {
    const choice = parseChoicePrompt([
      { label: '项目 A', description: '只读' },
      { label: '项目 B', description: '读写', callback_data: 'unsafe' },
      { label: '项目 B' },
      { callback_data: 'ignored' },
    ], '选择项目');

    assert.deepEqual(choice, {
      title: '选择项目',
      options: [
        { label: '项目 A', description: '只读' },
        { label: '项目 B', description: '读写' },
      ],
    });
    assert.equal(parseChoicePrompt([{ label: '只有一个' }]), undefined);
  });

  it('parses choices from the final envelope without trusting callback fields', () => {
    const result = prepareDeliveryCandidate([
      '```cti-final',
      JSON.stringify({
        kind: 'text',
        text: '请选择工作模式。',
        images: [],
        files: [],
        reply_mode: 'markdown',
        choice_title: '选择模式',
        choices: [
          { label: '安全模式', description: '只读检查', callback_data: 'model:unsafe' },
          { label: '完整模式', description: '允许写入' },
        ],
      }),
      '```',
    ].join('\n'), 'C:\\suite');

    assert.deepEqual(result.payload.choicePrompt, {
      title: '选择模式',
      options: [
        { label: '安全模式', description: '只读检查' },
        { label: '完整模式', description: '允许写入' },
      ],
    });
  });

  it('binds callbacks to the original chat, user and session and consumes them once', () => {
    let now = 1_000;
    const registry = new ChoicePromptRegistry({
      now: () => now,
      ttlMs: 60_000,
      nonceFactory: () => 'nonce_12345678',
    });
    const registered = registry.register({
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_owner',
      sessionId: 'session_1',
      prompt: '请选择工作目录。',
      choicePrompt: {
        title: '选择目录',
        options: [{ label: 'ST4' }, { label: 'Suite', description: '机器人项目' }],
      },
    });

    assert.equal(registered.options[1].callbackData, 'choice:select:nonce_12345678:1');
    assert.equal(registry.consume(registered.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_other',
    }).kind, 'forbidden');
    const selected = registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    });
    assert.deepEqual(selected, {
      kind: 'resolved',
      sessionId: 'session_1',
      prompt: '请选择工作目录。',
      title: '选择目录',
      option: { label: 'Suite', description: '机器人项目' },
    });
    assert.equal(buildChoiceSelectionText((selected as Extract<typeof selected, { kind: 'resolved' }>).option), '我选择：Suite\n选项说明：机器人项目');
    assert.equal(registry.consume(registered.options[1].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    }).kind, 'expired');

    const second = registry.register({
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner', sessionId: 'session_1', prompt: '再选一次',
      choicePrompt: { options: [{ label: 'A' }, { label: 'B' }] },
    });
    now += 60_001;
    assert.equal(registry.consume(second.options[0].callbackData, {
      channelType: 'feishu', chatId: 'oc_chat', userId: 'ou_owner',
    }).kind, 'expired');
  });

  it('renders workspace and agent choices through one Card 2.0 format', () => {
    const card = JSON.parse(buildFeishuChoiceCard({
      title: '选择工作目录',
      prompt: '请选择一个目录。',
      options: [
        { label: 'ST4', description: 'F:\\unity\\ST4', callbackData: 'workspace:switch:st4' },
        { label: 'Suite', callbackData: 'choice:select:nonce_12345678:1' },
      ],
    })) as any;

    assert.equal(card.schema, '2.0');
    assert.equal(card.header.title.content, '选择工作目录');
    const buttons = card.body.elements.filter((element: any) => element.tag === 'button');
    assert.deepEqual(buttons.map((button: any) => button.value.callback_data), [
      'workspace:switch:st4',
      'choice:select:nonce_12345678:1',
    ]);
  });
});
