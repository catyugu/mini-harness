import assert from 'node:assert/strict';
import test from 'node:test';
import { splitPoint } from '../src/server/compaction.ts';

test('retention includes the complete latest exchange even when it exceeds the minimum', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'History' }], timestamp: 0 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'probe', name: 'probe', arguments: {} }],
      timestamp: 0,
    },
    {
      role: 'toolResult',
      toolCallId: 'probe',
      toolName: 'probe',
      content: [{ type: 'text', text: 'diagnostics '.repeat(1000) }],
      state: 'finished',
      timestamp: 0,
    },
  ] satisfies import('@mini-harness/llm/api').NativeMessage[];
  assert.equal(splitPoint(messages, 10), 1);
});
