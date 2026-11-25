import assert from 'node:assert/strict';
import ts from 'typescript';
import { moduleReferences } from './module-references.ts';
import { execFile as exec } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readServerInfo } from '@mini-harness/host/process';
import { parseNpmPackResult } from './npm-pack.ts';
import { waitUntil } from '../test/support/api-fixture.ts';
import { createFixturePaths, createMockProvider } from '../test/helpers/mock-provider.ts';

const execFile = promisify(exec);
const npmPath =
  process.env.MINI_HARNESS_NPM_CLI ??
  resolve(
    dirname(process.execPath),
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : '../lib/node_modules/npm/bin/npm-cli.js',
  );
await access(npmPath);
const npm = (args: string[], options = {}) =>
  execFile(process.execPath, [npmPath, ...args], { timeout: 120000, ...options });

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  await new Promise<void>((done) => listener.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('Missing local port');
  return address.port;
}

async function checkPackage() {
  const work = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'mini-harness-pack-'));
  const mock = await createMockProvider(({ messages }) =>
    messages.at(-1)?.content === 'Pack smoke test'
      ? { tool: 'save_task_note', args: { note: 'Installed SDK recorded progress' } }
      : messages.at(-1)?.content === 'Pack scoped test'
        ? { tool: 'scoped_greeting', args: {} }
        : 'Mock response',
  );
  const { root, paths } = createFixturePaths(mock.url);
  const installed = join(work, 'install');
  const plugin = join(installed, 'task-notes');
  const env = { ...process.env, MINI_HARNESS_HOME: paths.home };
  let started = false;
  const cli = (...args: string[]) =>
    npm(['exec', '--offline', '--', 'mini-harness', ...args], { cwd: installed, env });
  try {
    const packed = await npm(['pack', '--json', '--pack-destination', work], { cwd: resolve('.') });
    const { name, filename, files } = parseNpmPackResult(packed.stdout);
    for (const profile of ['base', 'web'])
      assert.ok(
        files.some(({ path }: { path: string }) => path === 'profiles/' + profile + '.yml'),
        'Missing shipped Profile: ' + profile,
      );
    for (const path of [
      'dist/vendor/cordis/LICENSE',
      'dist/vendor/cordis-loader/LICENSE',
      'dist/vendor/cosmokit/LICENSE',
      'dist/vendor/cordis/src/index.js',
      'dist/vendor/cordis-loader/src/index.js',
      'dist/vendor/cordis-runtime/src/index.js',
      'dist/vendor/cosmokit/src/index.js',
    ])
      assert.ok(
        files.some((file) => file.path === path),
        'Missing vendored framework file: ' + path,
      );
    assert.ok(
      files.every(
        ({ path }: { path: string }) =>
          !/^dist\/(?:scripts|test)\//.test(path) &&
          !/^dist\/(?:packages|vendor)\/[^/]+\/package\.json$/.test(path) &&
          !/^dist\/.*\/tests\//.test(path) &&
          !/\.(?:test|spec)\.js$/.test(path),
      ),
      'Published package must exclude private manifests and test artifacts',
    );
    await mkdir(installed);
    const tarball = 'file:../' + filename;
    const { version: nodeTypes } = JSON.parse(
      await readFile(resolve('node_modules/@types/node/package.json'), 'utf8'),
    );
    // Use the Bedrock middleware version already selected by the workspace lockfile.
    const pi = createRequire(import.meta.resolve('@earendil-works/pi-ai'));
    const bedrock = createRequire(pi.resolve('@aws-sdk/client-bedrock-runtime'));
    const { version: websocketMiddleware } = bedrock('@aws-sdk/middleware-websocket/package.json');
    const fixture = {
      name: 'mini-harness-install-check',
      private: true,
      type: 'module',
      version: '0.0.0',
      dependencies: { [name]: tarball },
      devDependencies: { '@types/node': nodeTypes },
      overrides: { '@aws-sdk/middleware-websocket': websocketMiddleware },
    };
    await writeFile(join(installed, 'package.json'), JSON.stringify(fixture));
    console.log('Installing ' + filename + ' in a standalone npm project');
    await npm(
      ['install', '--prefer-offline', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: installed,
        timeout: 240000,
      },
    );
    const published = join(installed, 'node_modules', name);
    const manifest = JSON.parse(await readFile(join(published, 'package.json'), 'utf8'));
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      assert.doesNotMatch(JSON.stringify(manifest[section] ?? {}), /@mini-harness\/|workspace:\*/);
    const publicExports = manifest.exports as Record<string, { types: string; default: string }>;
    assert.ok(!Object.hasOwn(publicExports, './plugin') && !Object.hasOwn(publicExports, './browser-plugin'));
    for (const target of Object.values(publicExports)) {
      for (const path of [target.types, target.default])
        assert.ok(
          files.some((file) => file.path === path.slice(2)),
          'Missing public module: ' + path,
        );
    }
    for (const { path } of files.filter(({ path }) => /\.(?:js|d\.ts)$/.test(path))) {
      const emitted = await readFile(join(published, path), 'utf8');
      const source = ts.createSourceFile(path, emitted, ts.ScriptTarget.Latest, true);
      for (const { literal } of moduleReferences(source))
        assert.ok(
          !literal.text.startsWith('@mini-harness/'),
          path + ' depends on a private workspace: ' + literal.text,
        );
    }
    await execFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import 'mini-harness/tools'; import 'mini-harness/ui-runtime/plugin-settings'; import { Context } from 'mini-harness/cordis'; new Context();",
      ],
      { cwd: installed },
    );
    await writeFile(
      join(installed, 'plugin-types.mts'),
      `
      import { Context, type Plugin } from 'mini-harness/cordis';
      import type { LlmPort, ModelRequestContent } from 'mini-harness/llm';
      import type { ModelSource } from 'mini-harness/models';
      import { createScopeKey, type ScopeKey } from 'mini-harness/scopes';
      import type { ProfileConfiguration, ScopeSettings } from 'mini-harness/configuration';
      import { defineTool } from 'mini-harness/tools';
      import { executeTools, type ToolExecutorPort } from 'mini-harness/tools/execution';
      import type { PluginData, PluginSecrets } from 'mini-harness/plugin-data';
      import type { SessionRecords } from 'mini-harness/sessions';
      import type { Execution } from 'mini-harness/execution';
      import type { InputContext } from 'mini-harness/agent/events';
      import type { PromptPort } from 'mini-harness/agent/prompt';
      import type { CapabilityObservation } from 'mini-harness/observations';
      import type { ToolProjection } from 'mini-harness/conversation/display-events';
      import type { RoutePort } from 'mini-harness/transport';
      declare module 'mini-harness/cordis' {
        interface Context { example: { greet(name: string): string } }
      }
      declare const ctx: Context;
      const scopeKey: ScopeKey = createScopeKey();
      void scopeKey;
      const scope: ScopeSettings = { isolate: ['example'] };
      const scopedSettings: ProfileConfiguration['scopes'] = { 'session:example': scope };
      void scopedSettings;
      const llm: LlmPort | undefined = ctx.harnessLlm;
      const source: ModelSource = { list: () => [], resolve: () => undefined, capabilities: () => undefined };
      ctx.effect(() => ctx.harnessModels.register(source));
      const scopeContext: Context = ctx.harnessProfileScopes.context('session:example');
      void scopeContext;
      const plugin: Plugin = {
        apply(ctx) { ctx.provide('example', { greet: (name: string) => name.toUpperCase() }); }
      };
      ctx.example.greet('world');
      // @ts-expect-error The run scheduler is private.
      ctx.harnessRuns;
      ctx.harnessSessions.history('session');
      const pluginData: PluginData = ctx.harnessPluginData;
      const pluginSecrets: PluginSecrets = ctx.harnessPluginSecrets;
      const execution: Execution = ctx.harnessExecution;
      const records: SessionRecords = ctx.harnessSessions.records('session', { pluginId: 'fixture', instanceId: 'fixture' });
      const executor: ToolExecutorPort = ctx.harnessToolExecutor;
      void executeTools;
      void executor;
      const prompt: PromptPort = ctx.harnessPrompt;
      const routes: RoutePort = ctx.harnessRoutes;
      pluginData.write('state', { count: 1 });
      pluginSecrets.read('credential');
      ctx.on('internal/update', () => {});
      ctx.on('agent/prepare-input', (content, context: InputContext) => context.source === 'agent' ? content : undefined);
      ctx.on('agent/model-request', (request: ModelRequestContent) => ({ ...request, systemPrompt: request.systemPrompt.trim() }));
      ctx.effect(() => prompt.register({ id: 'status', render: ({ cwd }) => typeof cwd === 'string' ? cwd : undefined }));
      ctx.on('agent/tool-result', (content) => content);
      ctx.on('harness/observe', (event: CapabilityObservation) => {
        if (event.type === 'run-ended') void event.run.id;
      });
      ctx.on('conversation/tool-projection', ({ content }: ToolProjection) => content);
      void records.append({ seen: true });
      // @ts-expect-error Input listeners return native user content.
      ctx.on('agent/prepare-input', () => ({ arbitrary: true }));
      void ctx.harnessPluginSettings.set('showDetails', true);
      ctx.effect(() => routes.register('GET', '/api/example/:id', ({ params }) => params.id));
      ctx.effect(() => ctx.harnessUpgrades.register('/api/example/updates', (_request, socket, _head, signal) => {
        if (signal.aborted) socket.destroy();
      }));
      // @ts-expect-error The declared service takes a string.
      ctx.example.greet(1);
      // @ts-expect-error TypeScript plugins declare their own services.
      ctx.undeclared;
      // @ts-expect-error Execution handles own cancellation.
      execution.cancel('session');
    `,
    );
    await writeFile(
      join(installed, 'browser-types.mts'),
      `
      import { browserPluginSettings } from 'mini-harness/ui-runtime/plugin-settings';
      import type { SlotRenderer } from 'mini-harness/ui-slots';
      import type { ComposerModel } from 'mini-harness/conversation/composer';
      import type { ConversationController } from 'mini-harness/conversation/controller';
      import type { SettingsContribution } from 'mini-harness/ui-settings';
      import type { BrowserPrimitives } from 'mini-harness/ui-primitives';
      import type { RightTabsPort } from 'mini-harness/ui-layout';
      import type { Context } from 'mini-harness/cordis';
      declare module 'mini-harness/ui-slots' {
        interface SlotMap { 'example.panel': { kind: 'single' } }
      }
      declare const render: SlotRenderer;
      export function apply(ctx: Context) {
        const signal = ctx.fiber.signal;
        ctx.effect(() => ctx.miniSlots.register('sidebar.primary', render, { key: 'example' }));
        ctx.effect(() => ctx.miniSlots.register('example.panel', render, { key: 'example' }));
        // @ts-expect-error The contribution must be an element or a renderer.
        ctx.effect(() => ctx.miniSlots.register('sidebar.primary', 'example', { key: 'example' }));
        const model: ComposerModel = ctx.miniComposer;
        const conversation: ConversationController = ctx.miniConversation;
        const primitives: BrowserPrimitives = ctx.miniPrimitives;
        const tabs: RightTabsPort = ctx.miniTabs;
        tabs.onScopeChange(() => {}, signal);
        model.setText('Write a review');
        model.choose({ provider: 'local', id: 'example-model' });
        model.chooseThinking(null);
        void model.setPermission('readOnly');
        void model.addFiles([new File(['text'], 'notes.txt', { type: 'text/plain' })]);
        model.removeAttachment(0);
        model.subscribe(() => model.draft(), signal);
        void model.send();
        // @ts-expect-error The draft snapshot cannot be edited directly.
        model.draft().text = 'Replace this';
        conversation.subscribe(['partial'], () => conversation.get().partial, signal);
        ctx.effect(() => ctx.miniSettingsRegistry.register('example', { id: 'example', section: 'General', render: ({ configuration }) =>
          primitives.status(String(configuration.get<boolean>('showDetails')))
        } satisfies SettingsContribution, browserPluginSettings(ctx)));
      }
    `,
    );
    for (const file of ['plugin-types.mts', 'browser-types.mts'])
      await execFile(
        process.execPath,
        [
          resolve('node_modules/typescript/bin/tsc'),
          '--strict',
          '--noEmit',
          '--target',
          'ES2022',
          '--module',
          'NodeNext',
          file,
        ],
        { cwd: installed },
      );
    assert.match((await cli('--help')).stdout, /minimal native agent harness/);
    await cp(resolve('docs/examples/task-notes'), plugin, { recursive: true });
    await execFile(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
      cwd: plugin,
    });
    const examples = join(installed, 'sdk-examples');
    await mkdir(examples);
    const examplesNames = ['greeting-service', 'greeting-route', 'scoped-tool', 'browser-panel'];
    for (const example of examplesNames)
      await cp(resolve('docs/examples', example), join(examples, example), { recursive: true });
    await writeFile(
      join(examples, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          strict: true,
          noEmitOnError: true,
          rewriteRelativeImportExtensions: true,
        },
        include: ['**/*.ts'],
      }),
    );
    await execFile(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
      cwd: examples,
    });
    const additional = [];
    for (const id of examplesNames) {
      const directory = join(examples, id);
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'mini-harness-sdk-' + id,
          version: '1.0.0',
          type: 'module',
          exports: './plugin.js',
          peerDependencies: { 'mini-harness': '^0.4.0' },
        }),
      );
      const packed = parseNpmPackResult(
        (await npm(['pack', '--json', '--pack-destination', work], { cwd: directory })).stdout,
      );
      additional.push({ ...packed, id });
    }
    await cli('web', '--dump-config');
    const pluginPack = parseNpmPackResult(
      (await npm(['pack', '--json', '--pack-destination', work], { cwd: plugin })).stdout,
    );
    await cli(
      'plugin',
      '--profile',
      'web',
      'add',
      join(work, pluginPack.filename),
      ...additional.map(({ filename }) => join(work, filename)),
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
    );
    const profileDirectory = join(paths.home, 'profiles', 'web');
    const profileManifest = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'));
    assert.ok(profileManifest.dependencies[pluginPack.name]);
    await access(join(profileDirectory, 'node_modules', pluginPack.name, 'plugin.js'));
    await writeFile(
      join(paths.home, 'profiles', 'web', 'cordis.patch.yml'),
      JSON.stringify({
        plugins: [
          { id: 'task-notes', name: pluginPack.name, client: true, live: true },
          ...additional.map(({ id, name }) => ({
            id,
            name,
            ...(id === 'scoped-tool' ? { disabled: true } : {}),
            ...(id === 'browser-panel' ? { client: true } : {}),
          })),
        ],
      }),
    );
    const launch = await cli('--detached', '--cwd', paths.cwd, '--port', String(await availablePort()));
    assert.match(launch.stdout, /started independently/);
    started = true;
    const info = readServerInfo(paths.pid);
    assert.ok(info);
    const token = /#token=([a-f0-9]{64})/.exec(launch.stdout)?.[1];
    assert.ok(token);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const get = (path: string) => fetch(info.url + path, { headers });
    const write = (path: string, method: string, body: unknown) =>
      fetch(info.url + path, { method, headers, body: JSON.stringify(body) });
    for (const asset of [
      '/',
      '/packages/ui-runtime/src/browser/boot.js',
      '/packages/ui-runtime/src/browser/plugin-settings.js',
      '/packages/ui-primitives/src/browser/vendor/marked.js',
      '/packages/ui-primitives/src/browser/vendor/purify.js',
      '/logo.svg',
      '/manifest.webmanifest',
      '/startup.css',
      '/icon-192.png',
      '/icon-512.png',
      '/favicon.ico',
    ]) {
      const response = await get(asset);
      assert.equal(response.status, 200, asset);
      await response.arrayBuffer();
    }
    const plugins = await (await get('/api/plugins')).json();
    assert.ok(
      plugins.some(
        ({ id, state }: { id: string; state: string }) => id === 'task-notes' && state === 'ready',
      ),
    );
    assert.deepEqual(await (await get('/api/extensions/task-notes/smoke')).json(), {
      label: 'Task progress',
      ready: true,
      credential: false,
    });
    const patchLabel = (label: string) => write('/api/settings/plugins/task-notes', 'PATCH', { label });
    assert.equal((await patchLabel('   ')).status, 400);
    assert.equal((await patchLabel('Progress update')).status, 200);
    const secret = 'installed-fixture-token';
    const credential = await write('/api/extensions/task-notes/credential', 'PUT', { token: secret });
    assert.equal(credential.status, 200);
    assert.deepEqual(await credential.json(), { credential: true });
    assert.deepEqual(await (await get('/api/extensions/task-notes/smoke')).json(), {
      label: 'Progress update',
      ready: true,
      credential: true,
    });
    const bootstrap: import('@mini-harness/ui-runtime/bootstrap').BrowserBootstrap = await (
      await get('/api/bootstrap')
    ).json();
    assert.doesNotMatch(JSON.stringify(bootstrap), new RegExp(secret));
    assert.equal(bootstrap.ui.find(({ id }) => id === 'task-notes')?.config.label, 'Progress update');
    for (const { browser, styles } of bootstrap.ui) {
      if (browser) assert.equal((await get(browser)).status, 200, browser);
      for (const path of styles ?? []) {
        const css = await get(path);
        assert.equal(css.status, 200, path);
        assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
        await css.arrayBuffer();
      }
    }
    assert.ok(bootstrap.ui.some(({ id }: { id: string }) => id === 'core:conversation'));
    assert.ok(!bootstrap.ui.some(({ id }: { id: string }) => id === 'shell'));
    assert.deepEqual(await (await get('/api/greeting/hello/SDK')).json(), {
      greeting: 'Hello, SDK',
    });
    assert.equal(
      (
        await write('/api/settings', 'PATCH', {
          entries: { 'greeting-service': { config: { prefix: 'Installed' } } },
        })
      ).status,
      200,
    );
    assert.deepEqual(await (await get('/api/greeting/hello/SDK')).json(), {
      greeting: 'Installed, SDK',
    });
    const panel = bootstrap.ui.find(({ id }) => id === 'browser-panel');
    assert.ok(panel?.browser);
    assert.equal(panel.config.replaceComposer, false);
    assert.equal((await get(new URL('web/composer.js', info.url + panel.browser).pathname)).status, 200);
    const item = await (
      await fetch(info.url + '/api/sessions', { method: 'POST', headers, body: '{}' })
    ).json();
    const url = info.url + '/api/sessions/' + item.id;
    const startedRun = await fetch(url + '/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Pack smoke test' }),
    });
    assert.equal(startedRun.status, 202);
    const run = await startedRun.json();
    const chat = await fetch(url + '/events?run=' + run.id, { headers });
    assert.match(await chat.text(), /Mock response/);
    assert.match(JSON.stringify(mock.requests[0]?.messages), /Task notes are available/);
    const status = await (await fetch(url + '/runs', { headers })).json();
    assert.equal(status.run.state, 'completed');
    const conversation = await (await fetch(url, { headers })).json();
    assert.deepEqual(
      conversation.records.map(({ title, content }: { title: string; content: string }) => ({
        title,
        content,
      })),
      [{ title: 'Progress update', content: 'Installed SDK recorded progress' }],
    );
    const followUp = write('/api/extensions/task-notes/follow-up', 'POST', {
      parentId: item.id,
      message: 'Follow up',
      requireApproval: true,
    });
    void followUp.catch(() => {});
    const approvals = await waitUntil(
      async () => {
        const response = await get('/api/approvals');
        return (await response.json()) as { id: string; sessionId: string; plugin: string }[];
      },
      (pending) => pending.length === 1,
    );
    const [approval] = approvals;
    assert.equal(approval.sessionId, item.id);
    assert.equal(approval.plugin, 'task-notes');
    assert.equal((await write('/api/approvals', 'POST', { id: approval.id, allow: true })).status, 200);
    const response = await followUp;
    assert.equal(response.status, 200);
    const child = await response.json();
    assert.equal(child.state, 'completed');
    assert.equal(child.text, 'Mock response');
    assert.equal((await (await get('/api/sessions/' + child.childId)).json()).parentId, item.id);

    const scope = 'session:' + item.id;
    assert.equal(
      (
        await write('/api/settings', 'PATCH', {
          scopes: {
            [scope]: {
              entries: { 'scoped-tool': { name: 'mini-harness-sdk-scoped-tool', disabled: false } },
            },
          },
        })
      ).status,
      200,
    );
    const runIn = async (id: string, message: string) => {
      const base = '/api/sessions/' + id;
      const response = await write(base + '/runs', 'POST', { message });
      assert.equal(response.status, 202);
      const run = await response.json();
      assert.match(await (await get(base + '/events?run=' + run.id)).text(), /Mock response/);
      assert.equal((await (await get(base + '/runs')).json()).run.state, 'completed');
    };
    await runIn(child.childId, 'Pack scoped test');
    assert.match(JSON.stringify(mock.requests.at(-1)), /scoped_greeting/);
    const scopedHistory = await (await get('/api/sessions/' + child.childId)).json();
    assert.ok(
      scopedHistory.messages.some(
        (message: { role: string; content: unknown }) =>
          message.role === 'toolResult' && JSON.stringify(message.content).includes('Greeting returned.'),
      ),
    );
    const sibling = await (await write('/api/sessions', 'POST', {})).json();
    await runIn(sibling.id, 'Pack sibling test');
    assert.doesNotMatch(JSON.stringify(mock.requests.at(-1)?.tools), /scoped_greeting/);
    assert.equal((await write('/api/settings', 'PATCH', { scopes: {} })).status, 200);
    await runIn(child.childId, 'Pack after scope removal');
    assert.doesNotMatch(JSON.stringify(mock.requests.at(-1)?.tools), /scoped_greeting/);
    const disablePanel = async () => {
      assert.equal(
        (await write('/api/settings', 'PATCH', { entries: { 'browser-panel': { disabled: true } } })).status,
        200,
      );
    };
    if (process.argv.includes('--browser')) {
      const { chromium, expect } = await import('@playwright/test');
      const browser = await chromium.launch({ executablePath: process.env.MINI_HARNESS_CHROMIUM });
      try {
        const page = await browser.newPage();
        await page.goto(info.url + '/#token=' + token);
        const entry = page.getByRole('button', { name: 'Example panel', exact: true });
        await entry.click();
        await expect(page.getByText('Example panel is ready.')).toBeVisible();
        await page.getByRole('button', { name: 'Preview', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Example preview' });
        await expect(dialog).toBeVisible();
        await disablePanel();
        await expect(dialog).toHaveCount(0);
        await expect(entry).toHaveCount(0);
      } finally {
        await browser.close();
      }
    } else {
      await disablePanel();
    }
    assert.ok(
      !(await (await get('/api/bootstrap')).json()).ui.some(
        ({ id }: { id: string }) => id === 'browser-panel',
      ),
    );
    assert.equal((await get(panel.browser)).status, 404);

    assert.equal(
      (await write('/api/settings', 'PATCH', { entries: { 'task-notes': { disabled: true } } })).status,
      200,
    );
    assert.equal((await get('/api/extensions/task-notes/smoke')).status, 404);
    const withoutPlugin = (await (await get('/api/bootstrap')).json()) as typeof bootstrap;
    assert.ok(!withoutPlugin.ui.some(({ id }) => id === 'task-notes'));
    assert.deepEqual((await (await get('/api/sessions/' + item.id)).json()).records, conversation.records);

    assert.match((await cli('status')).stdout, /is running/);
    assert.match((await cli('stop')).stdout, /stopped/);
    started = false;
    await cli(
      'plugin',
      '--profile',
      'web',
      'remove',
      pluginPack.name,
      ...additional.map(({ name }) => name),
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
    );
    const afterRemoval = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'));
    assert.ok(!afterRemoval.dependencies?.[pluginPack.name]);
    for (const { name } of [pluginPack, ...additional]) {
      assert.ok(!afterRemoval.dependencies?.[name]);
      await assert.rejects(access(join(profileDirectory, 'node_modules', name)));
    }
    console.log(filename + ' passed clean installation, CLI, browser assets and native agent smoke checks');
  } finally {
    if (started) await cli('stop').catch(() => {});
    await mock.close();
    await Promise.all([
      rm(work, { recursive: true, force: true }),
      rm(root, { recursive: true, force: true }),
    ]);
  }
}

await checkPackage();
