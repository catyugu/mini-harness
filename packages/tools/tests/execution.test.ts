import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { defineTool, toolResultState } from '../src/api.ts';
import { nativeExecutor } from '../src/execution.ts';

const call = (id: string, name: string) => ({ type: 'toolCall' as const, id, name, arguments: {} });

test('a concurrent cancellation does not hide a genuine tool failure', async () => {
  const controller = new AbortController();
  const tool = defineTool({
    name: 'fail',
    description: 'Fail independently of cancellation',
    parameters: Type.Object({}),
    async execute() {
      controller.abort(new Error('Stopped by test'));
      throw new Error('Independent failure');
    },
  });
  const states: string[] = [];
  await nativeExecutor.execute([call('one', 'fail'), call('two', 'fail')], new Map([[tool.name, tool]]), {
    signal: controller.signal,
    async deliver(result) {
      states.push(toolResultState(result));
    },
  });
  assert.deepEqual(states, ['error', 'skipped']);
});

test('a fatal pipeline failure stops dispatch and drains active calls', async () => {
  const tool = defineTool({
    name: 'parallel',
    description: 'Parallel',
    parameters: Type.Object({}),
    isConcurrencySafe: () => true,
    async execute() {
      return { content: [] };
    },
  });
  const tools = new Map([[tool.name, tool]]);
  const calls = Array.from({ length: 18 }, (_, index) => call(String(index), 'parallel'));
  const started: string[] = [];
  let drained = 0;
  await assert.rejects(
    nativeExecutor.execute(calls, tools, {
      signal: new AbortController().signal,
      start(call) {
        started.push(call.id);
        return undefined;
      },
      update() {},
      async deliver(result, signal) {
        if (result.toolCallId === '0') throw new Error('Log write failed');
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        drained++;
      },
    }),
    /Log write failed/,
  );
  assert.equal(started.length, 16);
  assert.equal(drained, 15);
});
