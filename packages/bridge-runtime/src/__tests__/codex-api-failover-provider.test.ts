import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';

function collect(stream: ReadableStream<string>): Promise<string> {
  return (async () => {
    const reader = stream.getReader();
    let output = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += value;
    }
    return output;
  })();
}

describe('CodexApiFailoverProvider', () => {
  it('switches candidates when the current source produces no meaningful event before its deadline', async () => {
    const { CodexApiFailoverProvider } = await import('../main.js');
    let fallbackCalls = 0;
    const hangingProvider: LLMProvider = {
      streamChat: () => new ReadableStream<string>({ start() {} }),
    };
    const fallbackProvider: LLMProvider = {
      streamChat: () => {
        fallbackCalls += 1;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'fallback-ok' })}\n\n`);
            controller.close();
          },
        });
      },
    };
    const provider = new CodexApiFailoverProvider([
      { source: 'local_api', provider: hangingProvider },
      { source: 'official', provider: fallbackProvider },
    ], { candidateTimeoutMs: 25 });

    const output = await collect(provider.streamChat({
      sessionId: 'failover-deadline',
      prompt: 'hello',
      workingDirectory: process.cwd(),
      permissionMode: 'default',
    }));

    assert.equal(fallbackCalls, 1);
    assert.match(output, /fallback-ok/);
  });
});
