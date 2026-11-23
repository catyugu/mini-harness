# Plugin development

Put a `plugin.json` descriptor and `plugin.js`, `web.js`, or both in `~/.mini-harness/plugins/<id>/`. The Plugins page installs bundles up to 1 MiB and leaves them disabled until enabled. IDs start with a lowercase letter and can contain lowercase letters, digits and hyphens, up to 64 characters. Disable a plugin in every scope and remove any provider selection before uninstalling. Uninstalling permanently removes the bundle and its configuration. Review local code before enabling it.

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

`plugin.js` and `web.js` each export a default `setup(ctx, api)` function and may return cleanup. For TypeScript use `mini-harness/plugin` for the server API and service types, and `mini-harness/browser-plugin` for the browser API. Exported SDK types compile away. Bundles can use their own local ESM dependencies on the server. Bundle browser dependencies into `web.js` for the authenticated browser loader.

| Field | Contract |
| - | - |
| `scope` | `application` (default), `workspace` or `session` |
| `provides`, `inject`, `optional` | Server services published, required, or read opportunistically |
| `requires` | Required plugin IDs |
| `browserProvides`, `browserInject`, `browserRequires` | Published and required browser services, and required browser plugin IDs |
| `configSchema` | Self-contained JSON Schema for an object. Defaults apply before validation. |
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
| `provide(name, service)` | Publish a declared service for Cordis consumers |
| `service(name)` | Read a declared required service or fail with its name |
| `optionalService(name)` | Read a service declared in `optional` |
| `registerTool(tool)` | Register a native tool definition. Its signal aborts when the registration drains. |
| `registerRoute(method, path, handler)` | Authenticated route under `/api/extensions/<id>`. Handler receives URL, `body(maxBytes?)` and `signal`. Application scope only. |
| `records.list(id)` / `records.append(id, data)` | Namespaced custom records on the active native Session Log branch |
| `registerProjection({ initial, reduce })` | Build a computed view of this plugin's records on the active branch |
| `onDispose(cleanup)` | Register sync or async cleanup |

Declare `harnessRoutes` and `harnessTools` when using their registration methods. Return JSON from route handlers and honor their cancellation signals. Tool names contain 1–64 letters, digits, underscores or hyphens. Duplicate names at the same scope are rejected. A nearer scoped registration can replace an inherited tool, including a file tool; unloading it restores the inherited tool. All selected tools still pass inherited restrictions and policy decisions. Use the plugin lifetime signal for other work owned by setup. Use the model credential service for credentials; plugin configuration is not a secret store.

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

## Agent extensions

- `api.promptSection({ id, order, render })` adds a section rendered for every model turn. The renderer receives the session ID, workspace path, advertised tool metadata and a cancellation signal. The nearest scope wins for a shared ID. In the same scope, the alphabetically first plugin ID wins. Sections render in ascending order, then by section ID. Built-in sections use orders 0, 100, 200 and 300 for `base`, `tools`, `user-instructions` and `workspace-instructions`. Skills registers `skills` at 400. Plugin contributions default to 500.
- `api.modelRequest(handler, order?)` transforms the system prompt, messages, thinking level and output token limit before a turn or compaction request. Each resulting request is validated and written to the Session Log before transmission. Use a Prompt Section for additional system instructions.
- `api.toolResult(handler, order?)` transforms successful tool content for the model and conversation view. The original execution is written before the transform runs. A failed transform records a safe error and stops execution before sending another model request. Raw tool updates are withheld while a result transform is installed.
- Both transforms apply in ascending order, then by plugin ID. Return `undefined` to keep the previous value.
- `api.retryModel(handler)` can return `{ delayMs }` after a failed generation or compaction request and before any content has streamed. The first decision wins, with a limit of three attempts and a maximum delay of 30 seconds. Without a decision, the failure is returned immediately.
- `api.decideTool(handler)` receives the tool name, call ID, validated arguments, session ID and cancellation signal. Return `'deny'` to deny execution or `undefined` to defer to other handlers. A policy can await a confirmation before deciding. A rejection prevents execution. Shell still requires its own approval.
- `api.observe(handler)` receives copies of session, run, step, model-attempt and completed-tool events. Handler failures are reported independently of the operation. The executor continues while observers run.
- `api.transformTool(handler)` synchronously transforms displayed tool content in reverse registration order. It applies to live and saved views. A failed transform leaves the earlier display content in place.

Extensions follow scope ancestry and unregister with their owning plugin. Blocking handlers receive cancellation when the run stops or their owner unloads. Unload waits for in-flight callbacks to settle before running disposal. Callbacks should honor their signal and avoid waiting on their own plugin reconfiguration.

Tools execute serially by default. `isConcurrencySafe(args)` may opt a validated call into parallel execution with other opted-in calls. Keep it pure and return true only when the call can run alongside any other opted-in tool. A serial call waits for prior work to drain and completes before the following calls begin. The scheduler starts at most 16 calls from one turn at a time. A pipeline failure stops dispatch, signals in-flight calls and waits for them to settle. Ordinary tool errors are reported as durable results. Each result is persisted before its completion event.

## Session record projections

A projection computes state from the plugin's records on the current branch in log order. Each `read(sessionId)` starts with a fresh `initial()` value and uses a synchronous, deterministic reducer. Branch changes immediately affect subsequent reads. The returned handle belongs to the plugin lifetime and can also be released via `dispose()`.

```js
const plan = api.registerProjection({
  initial: () => [],
  reduce: (tasks, { data }) => [...tasks, data]
});
const tasks = await plan.read(sessionId);
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

A `scopes` entry can set `plugins`, `pluginConfig`, `providers` and `disabledTools`. Workspace and session plugins are server-only and are selected at a matching address. Registered tools and services are inherited by descendants. Tool restrictions apply transitively. An explicit `providers` selection allows a child service to shadow its ancestor within that subtree. The same provider ID at two addresses still represents two instances and requires an explicit choice. Removing the child provider restores inherited resolution; siblings remain independent. Host configuration, routes, scope resolution and mutation control cannot be replaced. See [scoped providers](scoped-providers.md). Use the workspace and session API IDs, and keep values in `pluginConfig` only for overrides. A Settings API PATCH supplying `providers` or `scopes` replaces the corresponding map.

Setup, schema or settings persistence failures retain the previous effective graph. A failed candidate that already drained resources cannot resume a cancelled call. Routes and tools dispose cooperatively. An unsuccessful browser setup removes its partial contributions and is reported in the Plugins page.

## Browser contributions

| API | Contract |
| - | - |
| `ui.button`, `ui.field`, `ui.menu`, `ui.status` | Shared visual primitives |
| `dialog(title, content)` | A shared modal registered under the plugin lifetime |
| `page(id, {title, content, order?})` | Register a page and sidebar entry |
| `slots.register(name, node, order?)` | Contribute to a layout or feature slot |
| `slots.registerKeyed(name, key, render, { order?, priority? }?)` | Contribute or override a keyed slot entry with a render lifetime |
| `slots.decorate(name, key, wrap, order?)` | Wrap a keyed entry, or all entries when the key is undefined |
| `settingsPage(title, node)` | Add a settings category |
| `rightTab(type, {title, create})`, `openTab(type, path?)` | Register or open a scoped workspace tab. Creation receives its address and an abort signal. |
| `inspect(title, node)` | Show content in the workspace inspector |
| `command({name, description, group?, run?})`, `completion(trigger, complete)` | Slash commands and punctuation-triggered suggestions |
| `tool(name, render)`, `toolAction(name, render)` | Register tool result presentation or controls |
| `messageAction({id, label, icon, visible, run})` | Register an action on the eligible messages |
| `beginDraftMode({title, text, submit})`, `cancelDraftMode()`, `insert(text)` | Own an editing flow or insert content into the composer |
| `request(path, options?)`, `signal`, `onDispose(cleanup)` | Authenticated requests and lifetime management |

Page, dialog, tab and inspector contributions depend on `core:layout`. Tools, message actions and composer operations depend on `core:conversation`. Settings pages depend on `core:settings`. The theme and primitives are shared. Declare the corresponding dependencies in `browserRequires` or declare the service in `browserInject`. Domain snapshots are provided by the owning feature's browser data plugin. The browser runtime routes revision notices and mounts the declared graph; it does not initialize sessions, settings, models or other feature state. Browser code runs with the page's permissions. Put custom UI listeners and requests under the plugin's lifetime and use contribution APIs to interact with another feature.

Keyed entries use the highest priority for each key, with the most recent registration breaking ties and restore the previous contribution when it is released. A renderer receives an abort signal and returns a node or `{ node, dispose }`. Decorators receive the current node and their own signal. Return the node itself for an in-place decoration or a wrapper containing it. On replacement or outlet removal, the registry aborts the render lifetime and calls cleanup. Use the renderer signal for listeners and subscriptions. For example, `sidebar.primary` publishes the built-in button under `new-conversation`. Declare the owner in `browserRequires` when overriding its contribution so your plugin mounts after it.

A data plugin declares its services in `browserProvides`, publishes them through
`ctx.provide`, and declares `miniProjections` in `browserInject` to follow a
projection domain. Wrap `ctx.miniProjections.register(domain, { sync })` in
`api.onDispose(...)`; `sync(revision, reconnect, sessionId?)` refreshes its owned
snapshot. `BrowserProjectionPort` is exported from `mini-harness/browser-plugin`.
Disposal removes the subscription and cancels invalidations that have not begun.

[Runnable examples](examples/) cover [publishing](examples/greeting-service/), [consuming](examples/greeting-route/) and [replacing](examples/process-preview/) a service, [scoped tools](examples/scoped-tool/), and [browser pages and actions](examples/browser-panel/). The test suites install and exercise these bundles.

## Run API

All API requests require `Authorization: Bearer <token>`.

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

Images (PNG/JPEG/GIF/WebP) enter the native multimodal message and require an image-capable model. UTF-8 text attachments are included in the model input. The conversation view displays their names alongside the original message. Limits: eight files, 6 MiB per image, 1 MiB per text file, 12 MiB total. Binary documents such as PDF/Office files are not parsed. Attachment content lives in the native Session Log; there is no independent upload store. Git inspection requires the selected workspace to be the repository root and caps output at 512 KiB. “Files written this turn” lists successful built-in `write`/`edit` paths; Git changes show the entire working tree, including earlier edits and shell changes.

The file and Skill endpoints return 404 when their plugin is disabled. The Approvals endpoint lists pending decisions from the active Shell tool. Disabling Shell cancels its pending requests. Every enabled built-in Shell call requires approval. Requests expire after five minutes; stopping the run or server cancels pending approval. Approval permits the command under the existing shell policy. Reviewed local plugins remain trusted code; this is not a general-purpose containment mechanism.
