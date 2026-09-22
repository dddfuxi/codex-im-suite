import assert from 'node:assert/strict';
import test from 'node:test';
import { getJevChatMode, isJevPureModeEnabled, setJevChatMode } from '../../lib/bridge/application/jev-mode.js';
import { isAutoJevQuestion } from '../../lib/bridge/bridge-manager.js';

test('Jev chat mode is isolated by channel and chat and can be disabled', () => {
  setJevChatMode('feishu', 'chat-a', 'pure');
  assert.equal(getJevChatMode('feishu', 'chat-a'), 'pure');
  assert.equal(isJevPureModeEnabled('feishu', 'chat-a'), true);
  assert.equal(isJevPureModeEnabled('telegram', 'chat-a'), false);
  assert.equal(isJevPureModeEnabled('feishu', 'chat-b'), false);

  setJevChatMode('feishu', 'chat-a', 'explicit');
  assert.equal(isJevPureModeEnabled('feishu', 'chat-a'), false);
  assert.equal(getJevChatMode('feishu', 'chat-a'), 'explicit');

  setJevChatMode('feishu', 'chat-a', null);
  assert.equal(getJevChatMode('feishu', 'chat-a'), null);
});

test('Jev auto mode only takes explicit judgment questions', () => {
  assert.equal(isAutoJevQuestion('这个方案是否应该继续？'), true);
  assert.equal(isAutoJevQuestion('请把这个文件部署到服务器'), false);
  assert.equal(isAutoJevQuestion('你好'), false);
});
