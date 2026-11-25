# Plugins

A plugin bundle contains `plugin.json` and at least one of `plugin.js` and `web.js`. Local and npm plugins run trusted JavaScript. Review the code, dependencies and browser assets before installing it. See [SECURITY.md](../SECURITY.md).

## Install and enable

Use Settings → Plugins to install local files and configure or enable a plugin. For npm packages, use:

```sh
mini-harness plugin install <id> <package>
mini-harness plugin update <id>
mini-harness plugin uninstall <id>
```

Disable an npm plugin and save before updating it. Installed plugins start disabled. Development mode accepts `MINI_HARNESS_DEV_PLUGIN=/absolute/path/to/plugin`. The directory name sets the plugin ID.

The manifest supplies display information, scope (`application`, `workspace`, or `session`), and optional JSON Schema and configuration-form metadata. Browser modules declare their dependencies and services directly with Cordis `inject` and `provide`. Browser styles and helper modules must be listed in `browserAssets`. Use `browserPreload` for a declared asset that exports a function receiving an activation signal and optionally returning cleanup.

## Declare a Cordis plugin

The CLI and browser load named `inject`, `provide` and `apply` exports or a default Cordis plugin. The host resolves public `mini-harness/*` modules from installed server plugins to the active installation. Import the public contract belonging to the service you use, such as `mini-harness/tools`, `mini-harness/agent`, or `mini-harness/llm`. Augment the public Cordis module to type your own services. Installed plugin code written for the old setup API needs migration to these declarations. Existing settings and owned records retain their namespace.

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

| Service                                        | Contract                                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harnessTools`                                 | Register a definition or a `{ name, bind(sessionId) }` factory. Read-only access also requires authorization for the selected registration.                                                                     |
| `harnessPrompt`                                | Register a named section, with an optional order and a render callback. The nearest scope wins for a shared ID.                                                                                                 |
| `harnessSessions`                              | `access()` returns the caller's visible conversation directory. `records(id)` reads or appends the instance's records on the active branch. Use `append(data, { title, content })` to publish a display record. |
| `harnessExecution`                             | `submit(id, input, { signal })` goes through normal admission and returns a handle with its own result and cancellation.                                                                                        |
| `harnessApprovalRequests`                      | `request(id, prompt, signal)` requests a user decision for a visible conversation.                                                                                                                              |
| `harnessPluginRoutes`                          | `register()` and `upgrade()` publish authenticated routes under `/api/extensions/<id>` for application plugins. `scope()` registers a workspace or session RPC.                                                 |
| `harnessPluginData` and `harnessPluginSecrets` | Read, write and remove data in the caller's own plugin and scope namespace.                                                                                                                                     |
| `harnessPluginSettings`                        | Read the current effective config, subscribe to committed changes or write this instance's configuration when it declares a live schema.                                                                        |
| `harnessPluginChanges`                         | Invalidate the plugin's browser projection after a domain mutation.                                                                                                                                             |

Use `await sessionService(ctx, sessionId, serviceName, signal)` to prepare a visible conversation and access a declared service with the caller's identity. Session writes and scope preparation belong in runtime calls after plugin setup. See [scoped providers](scoped-providers.md).

### Events

Register listeners with `ctx.on(event, handler, { order })`. Listeners are owned by the Fiber and visibility follows the target session's ancestry. Pipeline order is ascending, then by plugin instance ID.

| Event                          | Behavior                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `agent/prepare-input`          | Transform delivered user content or return `{ reject: reason }`. Read `original.userText` for text entered by the user. |
| `agent/model-request`          | Transform the system prompt, model-visible messages, thinking level or token limit.                                     |
| `agent/model-retry`            | Return `{ delayMs }` to retry a model attempt before output has streamed. The first decision applies.                   |
| `agent/tool-result`            | Transform successful results after persistence of the original execution.                                               |
| `tools/decide`                 | Return `'deny'` to restrict a tool call or `undefined` to defer.                                                        |
| `conversation/tool-projection` | Synchronously transform tool output in the conversation display.                                                        |
| `harness/observe`              | Observe session, run or turn events with an activation-bound cancellation signal.                                       |

### Configuration

Declare a `configSchema` in `plugin.json` to validate values and supply JSON defaults. Cordis plugins may also export a synchronous Standard Schema `Config`. Use the configuration passed to `apply` for activation. For live configuration, set `"configChanges": "live"` and register `ctx.on('internal/update', next => ...)` when in-memory resources need to change. Any error rejects the candidate and restores the prior configuration. The optional `validateConfig(config, { operation, service })` export can validate product constraints with the selected services.

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

- `miniSlots` defines outlets and registers elements or keyed renderers. Keyed renderers receive a signal for the view's lifetime.
- `miniPages`, `miniDialogs`, and `miniTabs` own page, dialog and tab resources. `miniTabs.register(type, definition)` returns a typed handle that accepts an owner, stable key, and payload. `miniTabs.contribute` adds an entry to the workspace panel.
- `miniFilePreview.open(resource, placement)` renders a workspace file, conversation attachment or temporary resource. Declare `miniFilePreview` for a required dependency or use optional access for integrations that also work with previews disabled.
- `miniComposer` handles drafts, commands and completions. `miniMessages` owns actions and renderers for history.
- `miniSettingsRegistry` registers settings sections and plugin-specific controls. Use `browserPluginSettings(ctx)` to bind configuration.
- `miniProjections` subscribes to state revisions. Use `browserRequest(ctx, path, options)` for authenticated requests bound to the activation.

The [Task notes example](examples/task-notes/) uses both entry points. The [browser panel](examples/browser-panel/) shows a keyed composer renderer. The [scoped examples](scoped-providers.md) show local service replacement.

### Profile entries

Installing a plugin makes it available in the catalog. To enable it, use the Web Plugins page or add an `installed:<id>` entry to the [active Profile](profiles.md). The server entry's `inject` and `provide` declarations govern Cordis. Missing required services leave the consuming entry waiting until Cordis can activate it.
