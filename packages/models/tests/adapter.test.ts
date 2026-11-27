import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiLlm } from '../src/server/pi-adapter.ts';
import { ModelStore } from '../src/server/store.ts';
import { createFixturePaths, createMockProvider } from '../../../test/support/mock-provider.ts';
import { readJson, writeJson } from '@mini-harness/platform/json';
import type { LlmEvent, NativeMessage } from '@mini-harness/llm/api';

test('model adapter streams native messages, tool calls and metadata through the HTTP provider', async (t) => {
  const mock = await createMockProvider(({ messages }) =>
    messages.at(-1)?.role === 'tool' ? 'Tool complete' : { tool: 'inspect', args: { path: 'note.txt' } },
  );
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new ModelStore(paths.home);
  t.after(async () => {
    await adapter.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await adapter.refresh();
  await new PiLlm(adapter).registerModels();
  const choice = { provider: 'local-mock', id: 'mock-model' };
  const input: NativeMessage = { role: 'user', content: 'Inspect the note', timestamp: Date.now() };
  const request = {
    model: choice,
    systemPrompt: 'You inspect files.',
    messages: [input],
    tools: [
      {
        name: 'inspect',
        description: 'Inspect a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    signal: new AbortController().signal,
  };
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
  const messages: NativeMessage[] = [
    input,
    final.message,
    {
      role: 'toolResult',
      content: [{ type: 'text', text: 'Contents' }],
      toolCallId: call.id,
      toolName: call.name,
      isError: false,
      timestamp: Date.now(),
    },
  ];
  let answer = '';
  for await (const event of new PiLlm(adapter).stream({ ...request, messages }))
    if (event.type === 'text-delta') answer += event.text;
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

  const models = adapter.providers().find(({ id }) => id === choice.provider)!.models;
  const edit = {
    id: choice.provider,
    name: 'Updated provider',
    api: 'openai-responses',
    baseUrl: mock.url + '/new',
    models,
  };
  await assert.rejects(
    adapter.saveProvider({ ...edit, api: 'unsupported-protocol' }),
    /Unsupported API protocol/,
  );
  const advanced = {
    ...models[0],
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: 'max' },
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  await assert.rejects(
    adapter.saveProvider({ ...edit, models: [{ ...advanced, thinkingLevelMap: { high: 5 } }] }),
    /Invalid thinking level map/,
  );
  await assert.rejects(
    adapter.saveProvider({ ...edit, api: 'google-generative-ai', models: [{ ...advanced, compat: { supportsDeveloperRole: false } }] }),
    /Unsupported compatibility settings/,
  );
  await adapter.saveProvider({
    ...edit,
    models: [{ ...advanced, compat: { supportsDeveloperRole: false } }],
  });
  await adapter.refresh();
  const restored = adapter.providers().find(({ id }) => id === choice.provider)!.models[0];
  assert.deepEqual(restored.thinkingLevelMap, advanced.thinkingLevelMap);
  assert.deepEqual(restored.cost, advanced.cost);
  assert.deepEqual(restored.compat, { supportsDeveloperRole: false });
  assert.deepEqual(adapter.capabilities(choice)?.thinkingLevels, ['off', 'low', 'medium', 'high', 'xhigh']);
  const selected = adapter.requestModel(choice)?.model;
  assert.equal(selected?.api, 'openai-responses');
  assert.equal(selected?.baseUrl, mock.url + '/new');
});

test('credential updates serialize across providers and survive adapter replacement without leaking keys', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new ModelStore(paths.home);
  t.after(async () => {
    await adapter.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await adapter.refresh();
  await new PiLlm(adapter).registerModels();
  await Promise.all([
    adapter.saveProvider({ id: 'openai', key: 'first-secret' }),
    adapter.saveProvider({ id: 'anthropic', key: 'second-secret' }),
  ]);
  const saved = JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8'));
  assert.equal(saved.openai.key, 'first-secret');
  assert.equal(saved.anthropic.key, 'second-secret');
  if (process.platform !== 'win32') assert.equal(statSync(join(paths.home, 'auth.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(
    JSON.stringify({ providers: adapter.providers(), status: adapter.authStatus('openai') }),
    /first-secret|second-secret/,
  );
  const replacement = new ModelStore(paths.home);
  await replacement.refresh();
  await new PiLlm(replacement).registerModels();
  await replacement.available();
  assert.deepEqual(replacement.authStatus('openai'), { configured: true, source: 'stored' });
  await replacement.removeProvider({ id: 'openai' });
  assert.equal(JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8')).openai, undefined);
  assert.equal(
    JSON.parse(readFileSync(join(paths.home, 'auth.json'), 'utf8')).anthropic.key,
    'second-secret',
  );
  await replacement.close();
});

test('built-in edits retain native routing and credentials, including after restoring the catalog', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const store = new ModelStore(paths.home);
  t.after(async () => {
    await store.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.refresh();
  const adapter = new PiLlm(store);
  await adapter.registerModels();
  const id = 'groq';
  const defaults = store.defaultModels(id);
  assert.ok(defaults.length);

  await store.saveProvider({ id, baseUrl: mock.url, key: 'groq-local-key', models: [] });
  assert.deepEqual(store.providers().find((provider) => provider.id === id)?.models, []);
  assert.equal(adapter.accepts({ provider: id, id: defaults[0].id }), false);
  const model = { provider: id, id: 'registered-model' };
  await store.saveProvider({
    id,
    baseUrl: mock.url,
    models: [{ ...defaults[0], id: model.id, contextWindow: 32768, maxTokens: 1024 }],
  });
  await store.refresh();
  assert.deepEqual(store.resolve(model), model);
  assert.equal(store.capabilities(model)?.name, defaults[0].name);
  assert.equal(adapter.accepts({ ...model, id: 'unregistered-model' }), false);
  const events: LlmEvent[] = [];
  for await (const event of adapter.stream({
    model,
    systemPrompt: '',
    messages: [{ role: 'user', content: 'Use the saved built-in configuration', timestamp: Date.now() }],
    signal: t.signal,
  }))
    events.push(event);
  assert.ok(events.some((event) => event.type === 'done' && event.message.stopReason === 'stop'));
  assert.equal(mock.requests.at(-1)?.model, model.id);
  // A native template remains explicit even if an older override used the same model ID.
  await store.saveProvider({
    id,
    baseUrl: mock.url,
    models: [{ ...defaults[0], id: defaults[1].id }],
  });
  const original = store.defaultModels(id).find((model) => model.id === defaults[1].id)!;
  await store.saveProvider({
    id,
    baseUrl: mock.url,
    models: [{ ...original, name: 'Restored then edited' }],
  });
  assert.equal(store.providers().find((provider) => provider.id === id)?.models[0].templateId, original.id);
  const restoredChoice = { provider: id, id: original.id };
  const expected = store.requestModel(restoredChoice)?.model;
  assert.ok(expected);
  assert.equal(expected.provider, id);
  assert.equal('models' in expected || 'authStatus' in expected || 'key' in expected, false);
  await store.refresh();
  assert.deepEqual(store.requestModel(restoredChoice)?.model, expected);
  assert.equal(expected?.contextWindow, original.contextWindow);

  const file = join(paths.home, 'models.json');
  const saved = readFileSync(file, 'utf8');
  const partial = { id: original.id, templateId: original.id };
  await assert.rejects(store.saveProvider({ id, models: [partial] }), /Missing model display name/);
  writeJson(file, { providers: {}, builtins: { [id]: { models: [partial] } } });
  await assert.rejects(store.refresh(), /Missing model display name/);
  assert.deepEqual(store.requestModel(restoredChoice)?.model, expected);
  writeFileSync(file, saved);
  await store.saveProvider({ id, baseUrl: '' });
  const restored = store.providers().find((provider) => provider.id === id);
  assert.ok(restored && restored.storedCredential && !restored.custom);
  assert.equal(restored.baseUrl, restored.defaultBaseUrl);
  assert.deepEqual(restored.models, defaults);
  assert.equal(adapter.accepts(model), false);
});

test('invalid provider refresh leaves the working catalog intact and unsupported images never issue a request', async (t) => {
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new ModelStore(paths.home);
  t.after(async () => {
    await adapter.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await adapter.refresh();
  await new PiLlm(adapter).registerModels();
  const model = { provider: 'local-mock', id: 'mock-model' };
  const config = readJson<any>(join(paths.home, 'models.json'), {});
  config.providers['local-mock'].apiKey = '!run-a-command';
  writeJson(join(paths.home, 'models.json'), config);
  await assert.rejects(adapter.refresh(), /literal values/);
  assert.deepEqual(adapter.resolve(model), model);
  await assert.rejects(async () => {
    for await (const _ of new PiLlm(adapter).stream({
      model,
      systemPrompt: '',
      signal: new AbortController().signal,
      messages: [
        {
          role: 'user',
          timestamp: Date.now(),
          content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }],
        },
      ],
    })) {
      /* drain */
    }
  }, /does not support image/);
  assert.equal(mock.requests.length, 0);
});

test('abort reaches the model transport and yields a native terminal message without retrying', async (t) => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = await createMockProvider(async () => {
    entered();
    await hold;
    return 'Late response';
  });
  const { root, paths } = createFixturePaths(mock.url);
  const adapter = new ModelStore(paths.home);
  t.after(async () => {
    release();
    await adapter.close();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  await adapter.refresh();
  await new PiLlm(adapter).registerModels();
  const controller = new AbortController();
  const pending = (async () => {
    const events: LlmEvent[] = [];
    for await (const event of new PiLlm(adapter).stream({
      model: { provider: 'local-mock', id: 'mock-model' },
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Wait', timestamp: Date.now() }],
      signal: controller.signal,
    }))
      events.push(event);
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

test(
  'authentication queries join checks without blocking edits and dispose cancelled work',
  { timeout: 10000 },
  async (t) => {
    const mock = await createMockProvider();
    const { root, paths } = createFixturePaths(mock.url);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changes: string[] = [];
    const errors: unknown[] = [];
    const store = new ModelStore(
      paths.home,
      (kind) => changes.push(kind),
      (error) => errors.push(error),
    );
    t.after(async () => {
      release();
      await store.close();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    await store.refresh();
    assert.equal(store.list().find(({ provider }) => provider === 'local-mock')?.configured, true);
    const model = {
      ...store.requestModel({ provider: 'local-mock', id: 'mock-model' })!.model,
      provider: 'slow-auth',
    };
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let check = async (_signal: AbortSignal) => {
      entered();
      await hold;
      return true;
    };
    const remove = await store.registerDefaults([
      {
        id: 'slow-auth',
        name: 'Slow auth',
        api: model.api,
        baseUrl: mock.url,
        canSetKey: true,
        models: [model],
        authStatus: (signal) => check(signal),
      },
    ]);
    await started;
    const firstQuery = store.available();
    let settled = false;
    void firstQuery.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    assert.equal((await firstQuery).find(({ provider }) => provider === 'slow-auth')?.configured, true);

    let checking!: () => void;
    const pending = new Promise<void>((resolve) => {
      checking = resolve;
    });
    let cancelled = 0;
    check = async (signal) => {
      checking();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            resolve();
          },
          { once: true },
        ),
      );
      return true;
    };
    const query = store.available();
    await pending;
    check = async () => {
      throw new Error('Authentication unavailable');
    };
    changes.length = 0;
    await store.saveProvider({ id: 'slow-auth', key: 'saved-key' });
    const available = await query;
    assert.equal(available.find(({ provider }) => provider === 'slow-auth')?.configured, false);
    assert.equal(cancelled, 1);
    assert.deepEqual(store.authStatus('slow-auth'), { configured: false, source: 'stored' });
    assert.ok(changes.length);
    assert.equal(
      changes.every((kind) => kind === 'auth'),
      true,
    );
    assert.ok(errors.some((error) => String(error).includes('slow-auth')));
    const startedRemoval = new Promise<void>((resolve) => {
      checking = resolve;
    });
    check = async (signal) => {
      checking();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            resolve();
          },
          { once: true },
        ),
      );
      return true;
    };
    const lastQuery = store.available();
    await startedRemoval;
    await remove();
    assert.equal(cancelled, 2);
    assert.equal(
      (await lastQuery).some(({ provider }) => provider === 'slow-auth'),
      false,
    );
    assert.equal(
      store.providers().some(({ id }) => id === 'slow-auth'),
      false,
    );
    assert.deepEqual(store.authStatus('slow-auth'), { configured: false });
    assert.ok(changes.includes('catalog'));
  },
);
