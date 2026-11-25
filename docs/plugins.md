# Plugins

An npm plugin can expose an ordinary Cordis module through its package.json `exports` or `main`. Presentation metadata is optional and may be declared in `miniHarness.plugin` in package.json. A local file bundle can also include optional `plugin.json` metadata. Local and npm plugins run trusted JavaScript. Review the code, dependencies and browser assets before installing it. See [SECURITY.md](../SECURITY.md).

## Install and enable

Use the Profile package manager to install, update and remove npm dependencies:

```sh
mini-harness plugin --profile web add <package>
mini-harness plugin --profile web update <package>
mini-harness plugin --profile web remove <package>
```

Installing a package changes only the selected Profile's npm dependencies. Declare an Entry in the Profile to activate it; restart before updating or removing packages used by a running application. npm lifecycle scripts follow your npm configuration and can execute package code during installation. To develop locally, declare the built package directory as an entry name in a Profile. Multiple local packages can run together. Use the Web Plugins page to enable and configure available entries; it does not install or delete code.

The manifest supplies display information, scope (`application`, `workspace`, or `session`), and optional configuration-form metadata. Browser modules declare their dependencies and services directly with Cordis `inject` and `provide`. A browser entry receives its configuration as a whole and can update it through `browserPluginSettings(ctx)` when the entry exposes a configuration contract. Keep server-only secrets in `harnessPluginSecrets` or a separate server entry; do not put them in browser entry configuration. Set `browser` to the browser entry module and `browserDirectory` to its dedicated build output directory. JavaScript chunks, styles, fonts and other supported assets inside that directory are published together; never put private files there. Use `browserPreload` for a published module that exports a function receiving an activation signal and optionally returning cleanup.

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

| Service                                        | Contract                                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harnessTools`                                 | Register a definition or a `{ name, bind(sessionId) }` factory. Read-only conversations admit registrations declaring read-only access, subject to inherited tool restrictions.                                 |
| `harnessPrompt`                                | Register a named section, with an optional order and a render callback. The nearest scope wins for a shared ID, then higher priority. Default prompt content is supplied by a separate plugin.                  |
| `harnessSessions`                              | `access()` returns the caller's visible conversation directory. `records(id)` reads or appends the instance's records on the active branch. Use `append(data, { title, content })` to publish a display record. |
| `harnessExecution`                             | `submit(id, input, { signal })` goes through normal admission and returns a handle with its own result and cancellation.                                                                                        |
| `harnessApprovalRequests`                      | `request(id, prompt, signal)` requests a user decision for a visible conversation.                                                                                                                              |
| `harnessPluginRoutes`                          | `register()` and `upgrade()` publish authenticated routes under `/api/extensions/<id>` for application plugins. `scope()` registers a workspace or session RPC.                                                 |
| `harnessPluginData` and `harnessPluginSecrets` | Read, write and remove data in the caller's own plugin and scope namespace.                                                                                                                                     |
| `harnessPluginSettings`                        | Read the current effective config, subscribe to committed changes or write this instance's configuration when the Profile marks its Entry as live.                                                              |
| `harnessPluginChanges`                         | Invalidate the plugin's browser projection after a domain mutation.                                                                                                                                             |

Use `await sessionService(ctx, sessionId, serviceName, signal)` to prepare a visible conversation and access a service with the caller's identity. Session writes and scope preparation belong in runtime calls after plugin setup. See [scoped providers](scoped-providers.md).

### Events

Use `agent/setup` to register capabilities for a particular running Agent. The callback receives its Cordis context, session ID and cancellation signal. Register run-local tools and prompt sections with `run.effect(() => run.get('harnessTools')!.register(...))` and `run.effect(() => run.get('harnessPrompt')!.register(...))`. These contributions are disposed with the run; child runs inherit active parent capabilities and keep their own overrides. Run-local tools declare their own access in the same way as other tools.

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

Export a synchronous Standard Schema `Config` (or attach `Config` to a default Cordis plugin object or class). Cordis resolves this schema before activation and updates. The optional SDK helper `defineConfig` from `mini-harness/configuration` builds a Standard Schema from JSON Schema and supplies defaults; its `jsonSchema` is also used for configuration forms. A manifest `configSchema`, if supplied, describes the form for unloaded entries only and does not validate runtime input. A browser-only package may export `Config` without an `apply` module on the server to validate its configuration without mounting a server fiber.

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

- `miniSlots` defines outlets and registers elements or keyed renderers. Keyed renderers receive a signal for the view's lifetime.
- `miniPages`, `miniDialogs`, and `miniTabs` own page, dialog and tab resources. `miniTabs.register(type, definition)` returns a typed handle that accepts an owner, stable key, and payload. `miniTabs.contribute` adds an entry to the workspace panel.
- `miniFilePreview.open(resource, placement)` renders a workspace file, conversation attachment or temporary resource. Declare `miniFilePreview` for a required dependency or use optional access for integrations that also work with previews disabled.
- `miniComposer` handles drafts, commands and completions. `miniMessages` owns actions and renderers for history.
- `miniSettingsRegistry` registers settings sections and plugin-specific controls. Use `browserPluginSettings(ctx)` to bind configuration.
- `miniProjections` subscribes to state revisions. Use `browserRequest(ctx, path, options)` for authenticated requests bound to the activation.

The [Task notes example](examples/task-notes/) uses both entry points. The [browser panel](examples/browser-panel/) shows a keyed composer renderer. The [scoped examples](scoped-providers.md) show local service replacement.

### Profile entries

Declare npm modules by their package name in the [active Profile](profiles.md). Local file bundles can be enabled in the Web Plugins page or declared by their directory path. The server entry's `inject` and `provide` declarations govern Cordis. Missing required services leave the consuming entry waiting until Cordis can activate it.
