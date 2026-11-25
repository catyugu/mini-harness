# Plugins

An npm plugin can expose an ordinary Cordis module through its package.json `exports` or `main`. Presentation metadata is optional. Export a `metadata` object from the server module; the same fields may be supplied statically in `plugin.json` or `miniHarness.plugin` in package.json. Native exports take precedence. An optional `<entry>.<exportName>.plugin.json` sidecar supplies module-specific static metadata (the default export uses `default`). Local and npm plugins run trusted JavaScript. Review the code, dependencies and browser assets before installing it. See [SECURITY.md](../SECURITY.md).

## Install and enable

Use the Profile package manager to install, update and remove npm dependencies:

```sh
mini-harness plugin --profile web add <package>
mini-harness plugin --profile web update <package>
mini-harness plugin --profile web remove <package>
```

Installing a package changes only the selected Profile's npm dependencies. Declare an Entry in the Profile to activate it; restart before updating or removing packages used by a running application. npm lifecycle scripts default to disabled; authorize them explicitly with `--ignore-scripts=false`. To develop locally, declare the built package directory as an entry name in a Profile. Multiple local packages can run together. Use the Web Plugins page to enable and configure available entries; it does not install or delete code.

Metadata supplies display information, not scope or authority. Any plugin may declare `browser`, `browserDirectory`, and ordered `browserStyles` relative to its distribution root. Package exports can also declare `./client` as the browser entry. Only the explicitly declared entry, styles and public build directory are published. If styles are omitted, CSS files in the public directory are discovered. Entries and their resources use versioned URLs regardless of their origin. Publish only dedicated browser build output. Browser entries receive their configuration directly; independent client entries have their own config. Keep credentials in `harnessPluginSecrets`.

## Declare a Cordis plugin

The CLI and browser load named `inject`, `provide` and `apply` exports or a default Cordis plugin. The host resolves public `mini-harness/*` modules from installed server plugins to the active installation. Import the public contract belonging to the service you use, such as `mini-harness/tools`, `mini-harness/agent`, or `mini-harness/llm`. Augment the public Cordis module to type your own services. An Entry ID identifies its persisted configuration and owned records.

```ts
import type { Context } from 'mini-harness/cordis';
import { defineTool } from 'mini-harness/tools';

export const inject = ['harnessTools'];

export function apply(ctx: Context) {
  ctx.effect(() =>
    ctx.harnessTools.register(
      defineTool({
        name: 'hello',
        description: 'Return a greeting.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: 'Hello' }] };
        },
      }),
    ),
  );
}
```

A service provider declares `provide = ['exampleGreeting']` and calls `ctx.provide('exampleGreeting', service)`. Declare required services in `inject`. Use `ctx.get(name)` for an intentional optional lookup. Give registrations and cleanup to `ctx.effect()` and use `ctx.fiber.signal` for cancellation. Use `ctx.fiber.run(work, requestSignal)` when teardown must wait for async work.

## Server services

| Service                                        | Contract                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harnessTools`                                 | Register a definition or a `{ name, resolve(resourceId) }` factory. Use `list()` to select standalone tools and `list({ scope, resourceId })` for scoped or resource-specific tools.                                                                                                                                                                  |
| `harnessModels`                                | Register a `ModelSource` and its adapter with dynamic resolution, shared scope, priority and lifetime.                                                                                                                                                                                                                                                |
| `harnessLlm`                                   | Register model streaming adapters and stream harness messages. The nearest matching scope wins, then higher priority.                                                                                                                                                                                                                                 |
| `harnessProcess`                               | Start an executable with `start(command, signal)` and use its stdio streams and exit promise.                                                                                                                                                                                                                                                         |
| `harnessFileAccess`                            | Use Node operations through `native` or open a directory view with `open(root, options)`.                                                                                                                                                                                                                                                             |
| `harnessPrompt`                                | Register a named section, with an optional order and a render callback. The nearest scope wins for a shared ID, then higher priority.                                                                                                                                                                                                                 |
| `harnessSessions`                              | Shared catalog, lifecycle and history operations accept explicit IDs. `create({ workspaceId: null })` creates an unbound conversation. `records<Data>(id, owner)` reads or appends typed records on the active branch; `log(id)` exposes the same durable record operations used by built-ins; the registry owns the writer path and close lifecycle. |
| `harnessExecution`                             | `submit(id, input, { signal })` goes through normal admission and returns a handle with its own result and cancellation.                                                                                                                                                                                                                              |
| `harnessApprovalRequests`                      | `request(id, prompt, signal)` requests a user decision for a conversation.                                                                                                                                                                                                                                                                            |
| `harnessRoutes` and `harnessUpgrades`          | Register ordinary authenticated HTTP routes (including dynamic path parameters) and WebSocket upgrades. Trusted gateways may forward authorized routes through `harnessNetwork`; they own viewer authentication and route authorization. Use `ctx.effect(() => service.register(...))` for lifecycle ownership.                                       |
| `harnessPluginData` and `harnessPluginSecrets` | Read, write and remove data in the caller's own plugin and scope namespace.                                                                                                                                                                                                                                                                           |
| `harnessPluginSettings`                        | Read the current effective config, subscribe to committed changes or write the owning Entry's configuration. A non-live Entry can restart and end the calling Fiber.                                                                                                                                                                                  |
| `harnessPluginChanges`                         | Invalidate the plugin's browser projection after a domain mutation.                                                                                                                                                                                                                                                                                   |

Runtime scopes use opaque object identities. Use `scopeOf(ctx)` from `mini-harness/scopes` to inspect the current registration scope. Resolve configured services directly from `harnessProfileScopes.context(address)` after preparing the Profile address. See [scoped providers](scoped-providers.md).

Runs uses the `readOnly` tag to select and start tools for read-only conversations. A custom `harnessToolExecutor` can present tools, interpret model messages and execute calls in another protocol. Import `ToolExecutorPort` and `executeTools` from `mini-harness/tools/execution` to reuse the native argument checks, scheduling, cancellation and result delivery.

### Events

A server plugin registers model metadata and streaming together through `harnessModels.register(source, adapter, priority)`. Both use the nearest scope, then highest priority; equal-ranked conflicts are unavailable rather than silently picking a source. Register an adapter alone through `harnessLlm.register(adapter, priority)` to override transport while preserving existing model capabilities. Its `accepts` predicate should inspect the model choice or its own source, not re-enter aggregate catalog resolution. The source lists discoverable models and resolves model choices and capabilities, including dynamically resolved choices. Provider configuration, credentials and protocols belong to the adapter. `@mini-harness/model-catalog` works independently of the Pi model store.

An independent Profile can compose `@mini-harness/agent` and `@mini-harness/llm` with its chosen adapter and Tool Executor. Pass `{ request, tools, signal }` to `harnessAgent.run(ctx, input)` to run an in-memory transcript. `request` takes the model, system prompt and messages. Runs prepares each turn when the conversation can accept queued input or switch models.

Use `agent/setup` to register capabilities for a particular running Agent. The callback receives its Cordis context, session ID and cancellation signal. Register run-local tools and prompt sections with `run.effect(() => run.get('harnessTools')!.register(...))` and `run.effect(() => run.get('harnessPrompt')!.register(...))`. Child runs inherit active parent contributions through the scope, and disposal removes the originating run’s contributions.

Register listeners with `ctx.on(event, handler)`. Return new values from transformation hooks and leave the supplied data intact. Listeners are owned by the Fiber; the domain selects the applicable context. Cordis uses registration order and supports `prepend` for an explicit leading listener. Plugin activation follows dependency declarations.

| Event                          | Behavior                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `agent/prepare-input`          | Return transformed user content. Throw an error to reject delivery. Read `original.userText` for the submitted text. |
| `agent/model-request`          | Transform the system prompt, model-visible messages, thinking level or token limit.                                  |
| `agent/model-retry`            | Return `{ delayMs }` to retry a model attempt before output has streamed. The first decision applies.                |
| `agent/tool-result`            | Transform successful results after persistence of the original execution.                                            |
| `conversation/tool-projection` | Synchronously transform tool output in the conversation display.                                                     |
| `harness/observe`              | Observe session and run events with an activation-bound cancellation signal.                                         |

### Configuration

Export a synchronous Standard Schema `Config` (or attach `Config` to a default Cordis plugin object or class). Cordis resolves this schema before activation and updates. The optional SDK helper `defineConfig` from `mini-harness/configuration` builds a Standard Schema from JSON Schema and supplies defaults; its `jsonSchema` is also used for configuration forms. Static `configSchema`, if supplied, supports forms without importing disabled modules; disabled entries retain their configuration and mounted entries validate on activation and updates. A browser-only package may export `Config` without an `apply` module on the server to validate its configuration without mounting a server fiber.

Set `live: true` on the Entry in `cordis.yml` or a Profile patch to allow in-place configuration changes. Register `ctx.on('internal/update', next => ...)` for resource changes or service-dependent checks, and check those constraints inside `apply` when mounting. Errors reject the candidate and restore the previous configuration. Non-live entries restart on configuration changes. Profile files contain user-supplied config, not schema defaults.

```ts
import { defineConfig } from 'mini-harness/configuration';
export const Config = defineConfig({
  type: 'object',
  properties: { label: { type: 'string', default: 'Notes' } },
  additionalProperties: false,
});
```

## Browser plugins

Use the same Cordis declarations. Browser modules import the same public specifiers via the browser import map, such as `mini-harness/cordis`, `mini-harness/ui-slots` and `mini-harness/ui-runtime/plugin-settings`. Server-only public modules are not published to the browser.

```js
export const inject = ['miniSlots'];

export function apply(ctx) {
  const button = document.createElement('button');
  button.textContent = 'Plugin action';
  ctx.effect(() => ctx.miniSlots.register('sidebar.actions', button));
}
```

Declare the services you use:

- `miniSlots` defines outlets and registers elements or keyed renderers. Pass a node or renderer to `register(name, contribution, options)`. A renderer receives the view's lifetime signal. Use `order` for display sequence and provide the same `key` with higher `priority` to replace a contribution. Equal priorities at the same key conflict.
- `miniPages`, `miniDialogs`, and `miniTabs` own page, dialog and tab resources. `miniTabs.register(type, definition)` returns a typed handle that accepts an owner, stable key, and payload. `miniTabs.contribute` adds an entry to the workspace panel.
- `miniFilePreview.open(resource, placement)` renders a workspace file, conversation attachment or temporary resource. Declare `miniFilePreview` for a required dependency or use optional access for integrations that also work with previews disabled.
- `miniComposer` handles drafts, commands and completions. `miniMessages` owns actions and renderers for history.
- `miniSettingsRegistry` registers settings sections and plugin-specific controls. Use `browserPluginSettings(ctx)` to bind configuration. `settings/options` is a native Cordis bail event for dynamic schema field choices; the first provider returning options supplies the selector.
- `miniProjections` subscribes to state revisions. Use `browserRequest(ctx, path, options)` for authenticated requests bound to the activation.

The [Task notes example](examples/task-notes/) uses both entry points. The [browser panel](examples/browser-panel/) shows a keyed composer renderer. The [scoped examples](scoped-providers.md) show local service replacement.

Declare npm packages and local paths explicitly in the [active Profile](profiles.md). Missing injected services leave a consumer waiting until Cordis can activate it.
