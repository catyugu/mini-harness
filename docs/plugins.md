# Plugin development

Put a `plugin.json` descriptor and `plugin.js`, `web.js`, or both in `~/.mini-harness/plugins/<id>/`. The Plugins page installs bundles up to 1 MiB and leaves them disabled until enabled. IDs start with a lowercase letter and can contain lowercase letters, digits and hyphens, up to 64 characters. Disable a plugin in every scope and remove any provider selection before uninstalling. Uninstalling permanently removes the bundle and its configuration. Installed server plugins are trusted local JavaScript and run with the OS permissions of the mini-harness process. Service declarations and the plugin API govern composition and lifecycle.

## npm distribution

Publish a standard npm package with `plugin.json` and its entries at the package root. A server entry needs `"type": "module"` in `package.json` and can import the package's npm dependencies. Bundle browser dependencies into a self-contained `web.js` of at most 1 MiB.

```sh
mini-harness plugin install my-tools @example/harness-tools
mini-harness plugin update my-tools
mini-harness plugin update my-tools @example/harness-tools@1.2.0
```

The first argument is the local plugin ID used in settings and routes. An unversioned name follows the registry's default tag. An explicit version stays pinned until you supply a new version or tag on update. Installation uses the npm CLI included with Node (or `MINI_HARNESS_NPM_CLI` for custom Node installations). There is no bundled package manager at runtime. It installs production dependencies, records an exact version and a `package-lock.json`, and disables lifecycle scripts. Stop the server before installing or updating. For an update, disable the plugin in every scope and clear its provider selections first. The CLI validates the staged package before publishing it and keeps existing plugin configuration. Enable the installed plugin in Settings or select it at its declared scope.

## Descriptor and entrypoints

A plugin with no descriptor fields can use `{}` as its `plugin.json`.

```json
{
  "title": "Conversation count",
  "description": "Count registered conversations.",
  "inject": ["harnessSessions", "harnessRoutes"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "prefix": { "type": "string", "default": "Count" }
    }
  }
}
```

`plugin.js` and `web.js` each export a default `setup(ctx, api)` function and may return cleanup. For TypeScript use `mini-harness/plugin` for the server API and service types, and `mini-harness/browser-plugin` for the browser API. Declare `mini-harness` as an npm dependency when the server entry imports runtime values from `mini-harness/plugin`. Local ESM bundles can install dependencies in their own plugin directory. Bundle browser dependencies into `web.js` for the authenticated browser loader.

| Field | Contract |
| - | - |
| `scope` | `application` (default), `workspace` or `session` |
| `provides`, `inject`, `optional` | Server services published, required, or read opportunistically |
| `requires` | Required plugin IDs |
| `browserProvides`, `browserInject`, `browserRequires` | Published and required browser services, and required browser plugin IDs |
| `configSchema` | Self-contained JSON Schema for an object. Defaults apply before validation. |
| `configChanges` | Set to `live` to apply validated changes without remounting the plugin. |
| `icon` | A symbolic icon name or an SVG path object with optional `viewBox` |

```js
export default function setup(_ctx, api) {
  const sessions = api.service('harnessSessions');
  api.registerRoute('GET', '/count', () => ({
    label: api.config.prefix,
    count: sessions.list().length
  }));
}
```

| Server API | Contract |
| - | - |
| `config`, `scope`, `signal` | Validated setup settings, scope address and lifetime signal |
| `configuration.get(key)`, `.subscribe(key, listener)` | Read a field or listen for committed changes in this instance’s namespace and scope |
| `configuration.set(key, value)`, `.patch(values)` | Validate and save fields in one transaction. The server SDK requires `configChanges: 'live'` for writes. |
| `provide(name, service)` | Publish a declared service for Cordis consumers |
| `service(name)` | Read a declared required service or fail with its name |
| `optionalService(name)` | Read a service declared in `optional` |
| `contribute(point, ...args)` | Register through a typed extension point owned by a capability. The host binds scope, identity and lifetime. |
| `registerRoute(method, path, handler)` | Authenticated route under `/api/extensions/<id>`. Handler receives URL, `body(maxBytes?)` and `signal`. Application scope only. |
| `onDispose(cleanup)` | Register sync or async cleanup |

Return JSON from route handlers and honor their cancellation signals. Use the plugin lifetime signal for other work owned by setup. Use the credential or secret store for sensitive values.

For TypeScript, `api.service('harnessLlm')` infers `LlmPort`. Declare your own names in the public service map. Declare the same names in the plugin descriptor so the host can validate them when it mounts the plugin.

```ts
import type { PluginApi } from 'mini-harness/plugin';

declare module 'mini-harness/plugin' {
  interface ServiceMap {
    greetings: { hello(name: string): string };
  }
}

export default function setup(_ctx: unknown, api: PluginApi) {
  api.provide('greetings', { hello: (name) => 'Hello, ' + name });
}
```

## Capability contributions

Import an extension point from `mini-harness/plugin` and register it through `api.contribute`.

```ts
import { agentExtensions, promptExtensions, type PluginApi } from 'mini-harness/plugin';

export default function setup(_ctx: unknown, api: PluginApi) {
  api.contribute(agentExtensions.prepareInput, (_content, { source, original }) => {
    if (source === 'user' && original.userText === '/offline') {
      return 'Complete the task using the conversation and local workspace.';
    }
  });
  api.contribute(promptExtensions.section, {
    id: 'project-style',
    render: () => 'Use the project’s existing conventions.'
  });
}
```

| Extension point | Contract |
| - | - |
| `agentExtensions.prepareInput` | Receives native user content and the context at delivery. Use `original.userText` for user commands and inspect `source` to distinguish user, agent and plugin submissions. Attachments are represented separately in `original`. Return native user content, `undefined` to keep the current content, or `{ reject: reason }` to stop delivery. |
| `agentExtensions.modelRequest` | Transforms model-visible messages, the system prompt, thinking level and output token limit for a turn or compaction. The Agent validates and records the prepared request before streaming. Automatic retries reuse it. |
| `agentExtensions.retryModel` | Returns `{ delayMs }` before output has streamed, or `undefined` to defer. The first decision applies, with at most three attempts and 30 seconds between attempts. |
| `agentExtensions.observe` | Receives a copy of the event and a cancellation signal. Events cover session, run, step, model attempt and completed tool activity. Observer failures are reported independently. |
| `promptExtensions.section` | Adds `{ id, order, render }` to the prompt. Renderers receive the session ID, workspace path, tool metadata and a signal. The nearest scope wins for a shared ID. The first plugin ID wins within one scope. Sections render by order and then section ID. The native orders are 0, 100, 200 and 300 for base, tools, user instructions and workspace instructions. Skills uses 400 and other contributions default to 500. |
| `toolExtensions.register` | Registers a definition or `{ name, bind(sessionId) }`. Declare `harnessTools` in `inject`. The optional `access: 'readOnly'` declaration is subject to a host grant on the actual plugin instance. |
| `toolExtensions.decide` | Receives the name, call ID, validated arguments, session and signal. Return `'deny'` to stop execution or `undefined` to defer. Decisions can only restrict access. |
| `agentExtensions.toolResult` | Transforms a successful result for model context and display. The original execution is persisted first. A transform failure records a safe error and stops the run. Raw progress content is withheld while a transform applies. |
| `sessionDisplayExtensions.project` | Transforms tool output in Conversation history, activity and event streams. It leaves persisted tool results and model-visible context intact. Projection failures preserve the earlier display content. |

Ordered transforms and decisions take an optional numeric order after the handler. They run in ascending order, then by plugin instance ID and registration order. The host copies transform data before invocation. Returning `undefined` discards any edits to the copy. Async callbacks receive a signal combining task cancellation with plugin unload. Unload stops new calls and waits for existing callbacks to settle before disposal.

Tool names contain 1–64 letters, digits, underscores or hyphens. Duplicate names in the same scope are rejected. A nearer registration shadows an inherited tool. Authorization checks the selected registration, including when a permission changes while a decision is pending. Tool execution is serial unless `isConcurrencySafe(args)` opts a call into parallel execution. Consecutive opted-in calls can overlap up to a limit of 16. The scheduler waits at serial boundaries and persists results before publishing completion.

## Session record projections

Declare `harnessSessions` in `inject` and acquire a record handle through `sessionExtensions.records`. The handle reads and appends this plugin's namespaced data on the active branch. A projection starts with a fresh initial value on each read and folds the branch with a synchronous reducer. Dispose a projection early with `dispose()` or let plugin unload release it.

```js
import { sessionExtensions } from 'mini-harness/plugin';

export default function setup(_ctx, api) {
  const records = api.contribute(sessionExtensions.records);
  const plan = records.projection({
    initial: () => [],
    reduce: (tasks, { data }) => [...tasks, data]
  });
  api.registerRoute('GET', '/tasks', ({ url }) => plan.read(url.searchParams.get('session')));
}
```

## Provider selection and scopes

In `settings.json`, `providers` maps service names to explicit enabled provider IDs. A replacement publishes the same contract. At application scope, replacing a plugin that provides multiple services requires replacements for all its services together. The LLM transport, model catalog and model administration use independent providers over the built-in model store. A workspace or session can replace one inherited service while its parent continues supplying the others. To restore the default, remove the selection and disable the replacement.

```json
{
  "plugins": { "process-preview": true, "shell": true },
  "providers": { "harnessProcess": "process-preview" },
  "scopes": {
    "workspace:<workspaceId>": {
      "disabledTools": ["sandbox_shell"]
    },
    "session:<sessionId>": {
      "plugins": { "scoped-tool": true }
    }
  }
}
```

A `scopes` entry can set `plugins`, `pluginConfig`, `providers` and `disabledTools`. Workspace and session plugins are server-only and are selected at a matching address. Registered tools and services are inherited by descendants. Tool restrictions apply transitively. An explicit `providers` selection allows a child service to shadow its ancestor within that subtree. The same provider ID at two addresses still represents two instances and requires an explicit choice. Removing the child provider restores inherited resolution; siblings remain independent. The host protects configuration, routes, scope resolution, mutation control and the Tools authorization provider. See [scoped providers](scoped-providers.md). Use the workspace and session API IDs, and keep values in `pluginConfig` only for overrides. A Settings API PATCH supplying `providers` or `scopes` replaces the corresponding map. Each entry supplied in `pluginConfig` replaces that plugin’s configuration and applies its schema defaults. Omitted plugin entries keep their saved values. The Plugins page shows the status of scoped instances and lets you repair their configuration.

Setup, schema or settings persistence failures retain the previous effective graph. A failed candidate that already drained resources cannot resume a cancelled call. Routes and tools dispose cooperatively. An unsuccessful browser setup removes its partial contributions and is reported in the Plugins page.

## Browser contributions

Call `api.contribute(point, ...args)` with a point exported by `mini-harness/browser-plugin`. Unbundled browser entries can import these same points from `/packages/ui-runtime/plugin-sdk.js`.

| Extension | Required `browserInject` services | Behavior |
| - | - | - |
| `layoutExtensions.dialog`, `.page` | `miniDialogs`, `miniPages` respectively | Mount a modal or a page with a sidebar entry |
| `layoutExtensions.tab`, `.openTab`, `.inspect` | `miniTabs` | Register or open a workspace tab or show content in the inspector |
| `slotExtensions.register`, `.keyed` | `miniSlots` | Add an element or a keyed renderer to a slot |
| `settingsExtensions.register` | `miniSettingsRegistry` | Render a plugin-owned Settings control |
| `conversationExtensions.command`, `.completion`, `.draft` | `miniComposer` | Register a command or completer, or open an editing draft |
| `conversationExtensions.tool`, `.toolAction`, `.messageAction` | `miniMessages` | Register tool presentation, tool controls, or a message action |

Inject `miniPrimitives` for shared controls via `ctx.miniPrimitives`, or `miniComposer` to insert text via `ctx.miniComposer.insert(text)`. Use `browserRequires` when a whole plugin must mount first, for example when replacing a specific contribution it installs. The browser API provides authenticated `request`, `configuration`, `signal`, and `onDispose`. Bind custom listeners and requests to that lifetime. Browser code runs with the page's permissions.

Settings contributions use a section title such as `General`, `Model`, or `Extensions`. A plugin can introduce a section with `{ title, icon, order }`. Contributions are sorted by order and plugin-qualified ID. Sections are ordered by their declared order and title. A section appears when it has content. Disabling a plugin removes its contributions and aborts their render signals.

Declare the settings fields and defaults in the plugin’s `configSchema`. For example, declare `showDetails` as a boolean with a default, then register its control from `web.js` with `miniSettingsRegistry` and `miniPrimitives` in `browserInject`.

```js
import { settingsExtensions } from '/packages/ui-runtime/plugin-sdk.js';

export default function setup(ctx, api) {
  api.contribute(settingsExtensions.register, {
    id: 'show-details',
    section: 'General',
    order: 50,
    render({ bind }) {
      const control = document.createElement('input');
      control.type = 'checkbox';
      const label = ctx.miniPrimitives.field('Show details', control);
      const status = bind(control, 'showDetails', {
        read: (value) => { control.checked = value; },
        write: () => control.checked
      });
      const row = document.createElement('div');
      row.append(label, status);
      return row;
    }
  });
}
```

`bind` handles committed values, pending state, error feedback and rollback. Custom controls can use `configuration` from the render context and the render signal to release their subscriptions. A write patches only the calling plugin’s namespace. Browser writes target the application scope. Native workspace and session plugins write that instance’s overrides. The server SDK permits writes after setup and outside configuration callbacks. Live plugins can use `onConfigChange` to stage updates and restore previous values on rollback. Subscribers see changes after commit. A section title affects layout only.

The most recent registration supplies each keyed contribution. Releasing it restores the previous contribution. A renderer receives an abort signal and returns a node or an object with a node and a cleanup function. The registry aborts its signal before cleanup on replacement or outlet removal. Declare the owner in `browserRequires` when overriding its contribution so your plugin mounts after it.

A data plugin declares its services in `browserProvides`, publishes them through
`ctx.provide`, and declares `miniProjections` in `browserInject` to follow a
projection domain. Wrap `ctx.miniProjections.register(domain, { sync })` in
`api.onDispose(...)`; `sync(revision, reconnect, sessionId?)` refreshes its owned
snapshot. `BrowserProjectionPort` is exported from `mini-harness/browser-plugin`.
Disposal removes the subscription and cancels invalidations that have not begun.

[Runnable examples](examples/) cover [publishing](examples/greeting-service/), [consuming](examples/greeting-route/) and [replacing](examples/process-preview/) a service, [scoped tools](examples/scoped-tool/), and [browser pages and actions](examples/browser-panel/). The test suites install and exercise these bundles.

## Run API

The local API requires a bearer credential. A trusted gateway can forward authenticated read-only viewer requests without disclosing that credential.

| Request | Result |
| - | - |
| `POST /api/sessions/:id/runs` with `{ "message": "...", "model": { "provider": "...", "id": "..." } }` | Starts a server-owned run; responds `202` with run ID and status. Both model and `thinkingLevel` are optional. |
| `GET /api/sessions/:id/runs` | Latest run status, including terminal errors |
| `GET /api/sessions/:id/events?run=<run-id>&after=<sequence>` | NDJSON events after the cursor; disconnecting removes only this observer |
| `POST /api/sessions/:id/compact` | Summarize earlier context while idle; preserve two complete recent turns |
| `POST /api/sessions/:id/cancel` | Explicitly cancel that conversation and running descendants |

Run states are queued, running, completed, failed, cancelled and interrupted. Event replay is bounded to 2,048 events and approximately 1 MiB per active conversation. An older cursor receives the native log projection and current output, then follows live events. Completed runs use saved history snapshots. The native Session Log persists messages, model choices, branch selection, inbox delivery, compaction, plugin records and run status. Restart marks unfinished runs interrupted and does not re-execute tools whose outcome is unknown.

## Workspace and GUI API

The server runs one Runtime for all registered workspaces. Each conversation has a stable Workspace ID. A request can address a conversation by ID or scope file and Skills requests to a registered Workspace ID. Deleting a Workspace permanently deletes all associated conversations and native session logs, including subagent descendants; it leaves the project directory and its files untouched.

| Request | Result |
| - | - |
| `GET /api/workspaces`, `POST /api/workspaces` with `{path, name?}` | List or register local directories |
| `GET /api/workspaces/directories?path=...` | Browse local subdirectories for registration |
| `PATCH /api/workspaces/:id` with `{name}`, `DELETE /api/workspaces/:id` | Rename a workspace or permanently delete its conversations and descendants while leaving the project directory intact |
| `PUT /api/workspaces` with `{ids}` | Reorder registered workspaces |
| `GET /api/bootstrap` | Mounted browser plugin graph |
| `GET /api/changes` | NDJSON stream with domain revisions and invalidations |
| `PATCH /api/settings/plugins/:id` | Patch fields in one active browser plugin’s configuration namespace |
| `GET /api/sessions`, `GET /api/settings`, `GET /api/plugins`, `GET /api/models` | Authoritative projections for the browser |
| `GET /api/workspaces/:id/sessions`, `POST /api/workspaces/:id/sessions` | List or create conversations in a workspace |
| `GET /api/providers`, `PUT /api/providers`, `DELETE /api/providers` | List credential status and model catalogs; save/remove custom endpoint definitions in `models.json` |
| `PATCH /api/sessions/:id` with `{title}` | Rename a conversation |
| `POST /api/sessions/:id/runs` with `{message, attachments?}` | Attachments are `{name, mimeType, data}` where `data` is base64 |
| `POST /api/sessions/:id/queue` with `{message, mode, attachments?}` | Native `steer` (at a tool boundary) or `followUp` (after the current task); maximum 16 queued messages |
| `GET /api/sessions/:id/queue` | Undelivered instructions and follow-ups |
| `GET /api/workspaces/:id/skills` | Names/descriptions from native SKILL.md discovery; invoke with `/skill:name` |
| `GET /api/workspaces/:id/files/tree?path=...`, `/files/search?q=...` in the same workspace | Workspace-scoped listing/search; search follows `.gitignore` |
| `GET /api/workspaces/:id/files/preview?path=...`, `/files/changes`, `/files/diff?path=...` in the same workspace | Bounded text and image preview, repository status, staged and working-tree differences |
| `GET /api/approvals`, `POST /api/approvals` with `{id, allow}` | Pending Shell requests; allow once or deny |

New images (PNG/JPEG/GIF/WebP) require an image-capable model. Text-only models receive a placeholder for earlier images. Editing a message keeps its original images unless you remove them. Reattach any original text files when editing. UTF-8 text attachments are included in the model input. The conversation view displays their names alongside the original message. Limits: eight files, 6 MiB per image, 1 MiB per text file, 12 MiB total. Binary documents such as PDF/Office files are not parsed. Attachment content lives in the native Session Log; there is no independent upload store. Git inspection requires the selected workspace to be the repository root and caps output at 512 KiB. “Files written this turn” lists successful built-in `write`/`edit` paths; Git changes show the entire working tree, including earlier edits and shell changes.

The file and Skill endpoints return 404 when their plugin is disabled. The Approvals endpoint lists pending decisions from the active Shell tool. Active runs must finish before Shell can be disabled. Disabling Shell clears any remaining approval requests. Standard conversations require approval for every enabled built-in Shell call. Full access conversations skip these prompts, including pending requests after a permission change; existing plugin and sandbox policies still apply. Requests expire after five minutes; stopping the run or server cancels pending approval. Approval permits the command under the existing shell policy. Reviewed local plugins remain trusted code; this is not a general-purpose containment mechanism.

## External development and resources

Run `mini-harness plugin dev <directory>` from a directory with a valid plugin descriptor. It builds the plugin, starts an isolated instance and restarts it after source changes so both the server and browser reload against the new graph.

Declare browser CSS, ESM chunks, images and fonts in `browserAssets`. Only listed files below `web/` and the entry `web.js` are served, and only while the plugin is enabled. Resources use same-origin URLs with their media types. The browser mounts styles in dependency order and removes them when the owning plugin unloads. `browserPreload` can select one listed ESM entry. Its default function receives a lifetime signal and may return cleanup. Pre-start functions run in the resolved dependency order before ordinary browser setup.

Mount HTTP routes with `api.registerRoute` and local WebSocket endpoints with `api.registerUpgrade`. The host authenticates upgrades, checks the browser origin and closes owned sockets when the plugin unloads. Gateway plugins create their own listener and authenticate the viewer before calling `harnessNetwork.forward`. The host authorizes only a read-only subset of its UI, session and workspace APIs on this path. Gateway credentials must be independent of the local management credential.

`pluginConfig` changes remount plugins by default. A plugin declaring `configChanges: "live"` registers one handler with `api.onConfigChange`. The handler receives validated configuration and can keep its services alive. A failed update to a healthy instance restores its previous configuration. A valid configuration for an inactive or failed optional instance can be saved even when the instance fails to start. Active runs block changes that would replace their configured providers or unload their plugins. Handlers should make updates reversible. Store private state with `api.storage` and keep credentials in `api.secrets`. Disabling a plugin keeps its data. Uninstall deletes its data and secrets. Each workspace or session mount has its own storage. Browser plugins can use `api.watch` to refresh their own snapshot after the server calls `api.invalidate`. `api.locale` reports the browser's language, supports change listeners and selects translations from a supplied dictionary.

### Read-only tool grants

A declaration of `access: 'readOnly'` does not confer authority. A local user can set `readOnlyTools` in settings (or the authenticated settings PATCH), for example `{"readOnlyTools":{"my-plugin":["inspect"]}}`. Grants name the installed plugin and exact registered tool; replacing the map or removing a tool revokes access even for already advertised tool leases. Removing the plugin also removes its grants. Only grant access to trusted implementations: local JavaScript already runs with your OS user privileges, and the declaration is not process isolation. Inherited disabled tools still deny execution, including in Full access.
