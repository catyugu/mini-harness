import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PiModelStore, PiLlm } from '../pi-adapter.js';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';
import { readJson, writeJson } from '@mini-harness/platform/json';
import type { LlmEvent, NativeMessage } from '@mini-harness/contracts/llm';

test('model adapter streams native messages, tool calls and metadata through the HTTP provider', async (t) => {
  const mock = await createMockProvider(({ messages }) => messages.at(-1)?.role === 'tool'
    ? 'Tool complete' : { tool: 'inspect', args: { path: 'note.txt' } });
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new PiModelStore(paths.home);
  t.after(async () => { await adapter.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await adapter.refresh();
  const choice = { provider: 'local-mock', id: 'mock-model' };
  const input: NativeMessage = { role: 'user', content: 'Inspect the note', timestamp: Date.now() };
  const request = { model: choice, systemPrompt: 'You inspect files.', messages: [input],
    tools: [{ name: 'inspect', description: 'Inspect a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    signal: new AbortController().signal };
  const first: LlmEvent[] = [];
  for await (const event of new PiLlm(adapter).stream(request)) first.push(event);
  const final = first.find((event) => event.type === 'done');
  assert.ok(final && final.type === 'done', 'Model must produce a terminal event');
  assert.equal(final.message.stopReason, 'toolUse');
  assert.ok(final.message.providerData);
  assert.equal(final.message.providerData.api, 'openai-completions');
  const call = final.message.content.find((part) => part.type === 'toolCall');
  assert.ok(call && call.type === 'toolCall');
  assert.deepEqual(call.arguments, { path: 'note.txt' });
  assert.ok(first.some((event) => event.type === 'tool-call' && event.call.id === call.id));
  const messages: NativeMessage[] = [input, final.message, { role: 'toolResult', content: [{ type: 'text', text: 'Contents' }],
    toolCallId: call.id, toolName: call.name, isError: false, timestamp: Date.now() }];
  let answer = '';
  for await (const event of new PiLlm(adapter).stream({ ...request, messages })) if (event.type === 'text-delta') answer += event.text;
  assert.equal(answer, 'Tool complete');
  const latest = mock.requests.at(-1);
  assert.ok(latest);
  const lastMessage = latest.messages as { role?: string }[];
  assert.equal(lastMessage.at(-1)?.role, 'tool');
  const capabilities = adapter.capabilities(choice);
  assert.ok(capabilities);
  assert.equal(capabilities.contextWindow, 32768);
  const configured = adapter.list().find(({ provider }) => provider === 'local-mock');
  assert.ok(configured);
  assert.equal(configured.configured, true);
});

test('credential updates serialize across providers and survive adapter replacement without leaking keys', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new PiModelStore(paths.home);
  t.after(async () => { await adapter.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await adapter.refresh();
  await Promise.all([adapter.storeCredential('openai', 'first-secret'), adapter.storeCredential('anthropic', 'second-secret')]);
  const saved = JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8'));
  assert.equal(saved.openai.key, 'first-secret');
  assert.equal(saved.anthropic.key, 'second-secret');
  if (process.platform !== 'win32') assert.equal(statSync(join(paths.home, 'auth.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify({ providers: adapter.providers(), status: adapter.authStatus('openai') }), /first-secret|second-secret/);
  const replacement = new PiModelStore(paths.home);
  await replacement.refresh();
  assert.deepEqual(replacement.authStatus('openai'), { configured: true, source: 'stored' });
  await replacement.removeCredential('openai');
  assert.equal(JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8')).openai, undefined);
  assert.equal(JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8')).anthropic.key, 'second-secret');
  await replacement.close();
});

test('invalid provider refresh leaves the working catalog intact and unsupported images never issue a request', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new PiModelStore(paths.home);
  t.after(async () => { await adapter.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await adapter.refresh();
  const model = { provider: 'local-mock', id: 'mock-model' };
  const config = readJson<any>(join(paths.home, 'models.json'), {});
  config.providers['local-mock'].apiKey = '!run-a-command';
  writeJson(join(paths.home, 'models.json'), config);
  await assert.rejects(adapter.refresh(), /literal values/);
  assert.deepEqual(adapter.resolve(model), model);
  await assert.rejects(async () => {
    for await (const _ of new PiLlm(adapter).stream({ model, systemPrompt: '', signal: new AbortController().signal,
      messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] }] })) { /* drain */ }
  }, /does not support image/);
  assert.equal(mock.requests.length, 0);
});

test('abort reaches the model transport and yields a native terminal message without retrying', async (t) => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const mock = await createMockProvider(async () => { entered(); await hold; return 'Late response'; });
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new PiModelStore(paths.home);
  t.after(async () => { release(); await adapter.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await adapter.refresh();
  const controller = new AbortController();
  const pending = (async () => {
    const events: LlmEvent[] = [];
    for await (const event of new PiLlm(adapter).stream({ model: { provider: 'local-mock', id: 'mock-model' }, systemPrompt: '',
      messages: [{ role: 'user', content: 'Wait', timestamp: Date.now() }], signal: controller.signal })) events.push(event);
    return events;
  })();
  await ready;
  controller.abort(new Error('Cancelled'));
  const terminal = (await pending).find((event) => event.type === 'done');
  assert.ok(terminal && terminal.type === 'done');
  assert.equal(terminal.message.stopReason, 'aborted');
  assert.equal(mock.requests.length, 1);
  release();
});

test('credential writes and removal roll back when authentication status refresh fails', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const store = new PiModelStore(paths.home);
  t.after(async () => { await store.close(); await mock.close(); rmSync(root, { recursive: true, force: true }); });
  await store.refresh();
  await store.storeCredential('anthropic', 'first-secret');
  const file = join(paths.home, 'auth.json');
  const before = readFileSync(file, 'utf8');
  const status = store.authStatus('anthropic');
  const target = store as unknown as { readStatus: () => Promise<unknown> };
  const original = target.readStatus;
  target.readStatus = async () => { throw new Error('Injected auth-status failure'); };
  try {
    await assert.rejects(store.storeCredential('anthropic', 'second-secret'), /Injected auth-status failure/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(store.authStatus('anthropic'), status);
    await assert.rejects(store.removeCredential('anthropic'), /Injected auth-status failure/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(store.authStatus('anthropic'), status);
  } finally { target.readStatus = original; }
});
