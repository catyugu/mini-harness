# Plugin development

Bundles use protocol 2. Put a `plugin.json` descriptor and `plugin.js`, `web.js`, or both in `~/.mini-harness/plugins/<id>/`. The Plugins page installs bundles up to 1 MiB and leaves them disabled until enabled. IDs start with a lowercase letter and can contain lowercase letters, digits and hyphens, up to 64 characters. Disable a plugin in every scope and remove any provider selection before uninstalling. Uninstalling permanently removes the bundle and its configuration. Review local code before enabling it.

## Descriptor and entrypoints

```json
{
  "protocol": 2,
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
| `protocol` | Required integer, currently `2` |
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
| `service(name)` | Read a required or optional declared service |
| `registerTool(tool)` | Register a Pi tool. Its signal aborts when the registration drains. |
| `registerRoute(method, path, handler)` | Authenticated route under `/api/extensions/<id>`. Handler receives URL, `body(maxBytes?)` and `signal`. Application scope only. |
| `records.list(id)` / `records.append(id, data)` | Namespaced Pi branch records |
| `onDispose(cleanup)` | Register sync or async cleanup |

Declare `harnessRoutes` and `harnessTools` when using their registration methods. Return JSON from route handlers and honor their cancellation signals. Tool names contain 1–64 letters, digits, underscores or hyphens. Built-in Pi coding-tool names are reserved. Use the plugin lifetime signal for other work owned by setup. Store credentials in Pi credential storage.

## Events

- `api.observe(handler)` observes created/deleted sessions, started/ended runs and completed tools. Observers receive copies and run asynchronously. Observer errors are reported without affecting the operation.
- `api.decideTool(handler)` participates before a tool executes. Cordis awaits handlers in registration order. The first `'deny'` stops the operation. A thrown error also prevents execution. Handlers receive the tool name, session ID and cancellation signal. Shell still requires its approval.
- `api.transformTool(handler)` synchronously transforms displayed tool content. Transformations compose in reverse registration order. They receive copies and apply to live and saved projections. Errors keep the prior projection. Pi model context and history keep their original contents.

Event subscriptions are scoped and are removed on disposal. Unload aborts pending policy work. A scoped observer can only see sessions in its scope and descendants.

## Provider selection and scopes

In `settings.json`, `providers` maps service names to explicit enabled provider IDs. A replacement publishes the same contract. If replacing a plugin that provides multiple services, select replacements for all its services together. To restore the default, remove the selection and disable the replacement.

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

A `scopes` entry can set `plugins`, `pluginConfig` and `disabledTools`. Workspace and session plugins are server-only and are selected at a matching address. Registered tools and services are inherited by descendants. Tool restrictions apply transitively. Duplicate providers in the same ancestry are rejected. Use the workspace and session API IDs, and keep values in `pluginConfig` only for overrides. A Settings API PATCH supplying `providers` or `scopes` replaces the corresponding map.

Setup, schema or settings persistence failures retain the previous effective graph. A failed candidate that already drained resources cannot resume a cancelled call. Routes and tools dispose cooperatively. An unsuccessful browser setup removes its partial contributions and is reported in the Plugins page.

## Browser contributions

| API | Contract |
| - | - |
| `ui.button`, `ui.field`, `ui.menu`, `ui.status` | Shared visual primitives |
| `dialog(title, content)` | A shared modal registered under the plugin lifetime |
| `page(id, {title, content, order?})` | Register a page and sidebar entry |
| `slots.register(name, node, order?)` | Contribute to a layout or feature slot |
| `settingsPage(title, node)` | Add a settings category |
| `rightTab(type, {title, create})`, `openTab(type, path?)` | Register or open a scoped workspace tab. Creation receives its address and an abort signal. |
| `inspect(title, node)` | Show content in the workspace inspector |
| `command({name, description, group?, run?})`, `completion(trigger, complete)` | Slash commands and punctuation-triggered suggestions |
| `tool(name, render)`, `toolAction(name, render)` | Register tool result presentation or controls |
| `messageAction({id, label, icon, visible, run})` | Register an action on the eligible messages |
| `beginDraftMode({title, text, submit})`, `cancelDraftMode()`, `insert(text)` | Own an editing flow or insert content into the composer |
| `request(path, options?)`, `signal`, `onDispose(cleanup)` | Authenticated requests and lifetime management |

Page, dialog, tab and inspector contributions depend on `core:layout`. Tools, message actions and composer operations depend on `core:conversation`. Settings pages depend on `core:settings`. The theme and primitives are shared. Declare the corresponding dependencies in `browserRequires` or declare the service in `browserInject`. Browser code runs with the page's permissions. Put custom UI listeners and requests under the plugin's lifetime and use contribution APIs to interact with another feature.

[Runnable examples](examples/) cover [publishing](examples/greeting-service/), [consuming](examples/greeting-route/) and [replacing](examples/process-preview/) a service, [scoped tools](examples/scoped-tool/), and [browser pages and actions](examples/browser-panel/). The test suites install and exercise these bundles.

## Run API

All API requests require `Authorization: Bearer <token>`.

| Request | Result |
| - | - |
| `POST /api/sessions/:id/runs` with `{ "message": "...", "model": { "provider": "...", "id": "..." } }` | Starts a server-owned run; responds `202` with run ID and status. Both model and `thinkingLevel` are optional. |
| `GET /api/sessions/:id/runs` | Latest run status, including terminal errors |
| `GET /api/sessions/:id/events?run=<run-id>&after=<sequence>` | NDJSON events after the cursor; disconnecting removes only this observer |
| `POST /api/sessions/:id/compact` | Ask Pi to summarize earlier context while the conversation is idle |
| `POST /api/sessions/:id/cancel` | Explicitly cancel that conversation and running descendants |

Run states are queued, running, completed, failed, cancelled and interrupted. Event replay is bounded to 2,048 events and approximately 1 MiB per active conversation. An older cursor receives a snapshot of Pi history and current output, then follows live events. Completed runs use saved history snapshots. The server persists latest status and Pi JSONL, rather than a separate execution context or an event archive.

## Workspace and GUI API

The server runs one Runtime for all registered workspaces. Each conversation has a stable Workspace ID. A request can address a conversation by ID or scope file and Skills requests to a registered Workspace ID. Deleting a Workspace permanently deletes all associated conversations and Pi session files, including subagent descendants; it leaves the project directory and its files untouched.

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
| `GET /api/providers`, `PUT /api/providers`, `DELETE /api/providers` | List credential status and model catalogs; save/remove custom endpoint definitions in Pi `models.json` |
| `PATCH /api/sessions/:id` with `{title}` | Rename a conversation |
| `POST /api/sessions/:id/runs` with `{message, attachments?}` | Attachments are `{name, mimeType, data}` where `data` is base64 |
| `POST /api/sessions/:id/queue` with `{message, mode, attachments?}` | Pi `steer` (after the current tool batch) or `followUp` (after the current task); maximum 16 queued messages |
| `GET /api/sessions/:id/queue` | Undelivered instructions and follow-ups |
| `GET /api/workspaces/:id/skills` | Names/descriptions discovered by Pi; invoke with `/skill:name` |
| `GET /api/workspaces/:id/files/tree?path=...`, `/files/search?q=...` in the same workspace | Workspace-scoped listing/search; search follows `.gitignore` |
| `GET /api/workspaces/:id/files/preview?path=...`, `/files/changes`, `/files/diff?path=...` in the same workspace | Bounded text and image preview, repository status, staged and working-tree differences |
| `GET /api/approvals`, `POST /api/approvals` with `{id, allow}` | Pending Shell requests; allow once or deny |

Images (PNG/JPEG/GIF/WebP) go through Pi's image input and require an image-capable model. UTF-8 text attachments are included in the Pi model input. The conversation view displays their names alongside the original message. Limits: eight files, 6 MiB per image, 1 MiB per text file, 12 MiB total. Binary documents such as PDF/Office files are not parsed. Attachment content lives in the Pi conversation; there is no independent upload store. Git inspection requires the selected workspace to be the repository root and caps output at 512 KiB. “Files written this turn” lists successful built-in `write`/`edit` paths; Git changes show the entire working tree, including earlier edits and shell changes.

The file and Skill endpoints return 404 when their plugin is disabled. The Approvals endpoint lists pending decisions from the active Shell tool. Disabling Shell cancels its pending requests. Every enabled built-in Shell call requires approval. Requests expire after five minutes; stopping the run or server cancels pending approval. Approval permits the command under the existing shell policy. Reviewed local plugins remain trusted code; this is not a general-purpose containment mechanism.
