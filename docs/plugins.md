# Local plugins

Install reviewed ESM code in `~/.mini-harness/plugins/<id>/plugin.js`. IDs start with a lowercase letter and contain lowercase letters, digits and hyphens (up to 64 characters). Plugins run with your user permissions. Enable them in the Plugins page. Settings also links to this page.

## Manifest and configuration

`plugin.json` supplies metadata, required plugins, and a JSON Schema for configuration:

```json
{
  "title": "Conversation count",
  "description": "Count registered conversations.",
  "requires": ["files"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["prefix"],
    "properties": {
      "prefix": {
        "type": "string",
        "title": "Prefix",
        "description": "Text before the count.",
        "default": "Count",
        "minLength": 1
      }
    }
  }
}
```

Dependencies must be enabled; cycles and missing dependencies reject the configuration before unloading anything. Built-in IDs are `files`, `skills`, `subagents`, `shell` and `session-helper`.

The GUI renders strings, booleans, numbers, integers, enums and nested objects from the schema. Other values use JSON input. Use `title`, `description`, `default`, `required`, bounds and `additionalProperties` to describe the accepted configuration. Keep schemas self-contained; external references are unsupported. Defaults apply recursively to object properties, then TypeBox validates the resulting value. Store configuration in `settings.json` under `pluginConfig.<id>`; it is ordinary local configuration, so use Pi credential storage for model secrets.

## Entry point

```js
export const inject = ['harnessSessions'];

export default function setup(ctx, api) {
  const { prefix } = api.config;
  api.registerRoute('GET', '/count', () => ({ count: ctx.harnessSessions.list().length }));
  api.registerTool({
    name: 'conversation_count',
    label: 'Conversation count',
    description: 'Count registered conversations.',
    parameters: { type: 'object', properties: {} },
    async execute(_callId, _args, signal) {
      signal?.throwIfAborted();
      return {
        content: [{ type: 'text', text: prefix + ': ' + ctx.harnessSessions.list().length }]
      };
    }
  });
  const timer = setInterval(() => {}, 60000);
  api.onDispose(() => clearInterval(timer));
}
```

The default export can also be a Cordis component with `apply` and `inject`. Declare service names with `inject`; declare plugin IDs with manifest `requires`. Register tools during setup and honor cancellation in tool execution.

| API | Purpose |
| - | - |
| `api.config` | Cloned, read-only top-level configuration with schema defaults applied |
| `api.defineConfig(defaults, validate?)` | Optional JavaScript defaults and validation, including plugins without a schema |
| `api.registerTool(tool)` | Register a Pi tool and return an async unregister function |
| `api.registerRoute(method, path, handler)` | Mount an authenticated JSON route under `/api/extensions/<id>` and return an async unregister function |
| `api.records.list(sessionId)` / `append(sessionId, data)` | Read or append this plugin’s JSON records on the current Pi branch |
| `api.onDispose(cleanup)` | Register synchronous or asynchronous resource cleanup |
| Returned cleanup function | Alternative cleanup for the setup function |

Tool names must be unique, use letters, digits, underscores or hyphens, and be 1–64 characters long. Built-in coding-tool names are reserved even while the file plugin is disabled.

## Services and lifecycle

Public metadata services are `harnessModels.list()` and `harnessSessions.get(id)` / `list()`. Read plugin settings through `api.config` and register tools and routes through the plugin API. Session metadata is returned as a snapshot. Plugin records live in the Pi JSONL as namespaced Custom Entries. Pi starts the file on the first conversation message and leaves Custom Entries out of model context.

Built-in and local setup functions run in Cordis scopes. Dependencies mount first and unload last. Disabling a required plugin also requires disabling its dependents. Reconfiguring a dependency restarts its enabled dependents. Unchanged plugin scopes stay mounted. A route handler receives `{ url, body(maxBytes?), signal }`. The signal aborts when its route unloads. Read JSON with `await body()` and return a JSON-serializable result.

Schema validation precedes setup. If setup or settings persistence fails, the host unloads new scopes and restores the previous plugin configuration. Cleanup handlers must release their resources and tolerate partial setup; failure to restore is reported explicitly. Changes affecting active tools or Skills require idle conversations, and invalidate Pi sessions so their next open gets the current tool definitions. Theme, scheduling, execution policy and model-selection changes preserve running sessions. Changes to child depth refresh tool availability when a session is next idle.

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

## Browser extensions

A local plugin may include a self-contained ESM `web.js` beside `plugin.js`. Its default export receives the browser API below. Bundle browser dependencies into this one file; relative imports and Node APIs are unavailable. The browser fetches it through the authenticated API and only loads enabled plugins. It runs as trusted page code and can access the same interface as the user.

```js
export default function setup(api) {
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = api.config.label ?? 'Task notes';
  open.onclick = () => {
    const text = document.createElement('p');
    text.textContent = 'Notes for the current task';
    api.inspect('Task notes', text);
  };
  api.mount('sidebar', open);
  api.tool('conversation_count', (result) => {
    const output = document.createElement('p');
    output.textContent = typeof result.content === 'string' ? result.content :
      (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    return output;
  });
}
```

| API | Behavior |
| - | - |
| `mount('sidebar', node, order?)` | Add a sidebar entry. Lower orders appear first. |
| `command({name, description, group?, run?})` | Register a slash suggestion. Omit the leading slash from the name. With no callback the command is inserted into the draft. |
| `mount('composer', node)` | Add an input toolbar control |
| `completion(trigger, complete)` | Register a punctuation-triggered input completion. The callback receives `{query, signal, show, replace}`. |
| `toolAction(name, render)` | Add a control to a tool result while keeping its normal output. |
| `tool(name, render)` | Register one renderer for a tool name; returning `undefined` uses the generic result view |
| `settingsPage(title, node)` | Register a settings category and its content |
| `mount('settings', node)` | Add content to the shared Extensions category |
| `mount('inspector', node)` | Add a right-panel entry; use `inspect(title, node)` to show its content |
| `insert(text)` | Insert text at the input selection |
| `request(path, options?)` | Request authenticated JSON from `/api` using a path such as `/sessions` |
| `signal` | Aborts when the browser plugin scope unloads. Requests made through the API use it automatically. |
| `config` | Same validated configuration and schema defaults as the server plugin |
| `onDispose(cleanup)` / returned cleanup | Release listeners, timers and other browser resources |

The browser runs each plugin in a Cordis scope and disposes its slots, completions, settings pages, tool registrations and inspector content when the scope unloads. Pass `api.signal` to document or window listeners or release them with `onDispose`. Dependencies mount first and dispose last; configuration changes also rebuild dependent browser extensions. Setup failures remove partial contributions and leave ordinary chat available. The catalog reports which browser plugins failed after the server saved a change. The backend and UI share one plugin switch; attachments, file inspection and Skills use these same extension interfaces.

The Plugins page can install a local bundle containing `plugin.js`, `web.js` or both, with optional `plugin.json` (at most 1 MiB combined). New installations stay disabled. Disable the plugin before uninstalling; uninstall removes the local plugin directory permanently. Larger development plugins can still be placed in the local plugins directory manually.

Register a right-panel tab with `api.rightTab(type, { title, create })`. Both callbacks receive an address with `workspaceId`, optional `sessionId`, and optional `path`. `create(address, signal)` returns the tab's element and receives an abort signal for any in-flight work. Call `api.openTab(type, path?)` to open or focus the tab in the current conversation or workspace. Changing conversations aborts and releases the outgoing tab views. Registered tabs keep their address and selection, and recreate their views on return. Inspector content added with `inspect` lasts for the current scope. Disabling a plugin closes its tabs.

## GUI API additions

The server runs one Runtime for all registered workspaces. Each conversation has a stable Workspace ID. A request can address a conversation by ID or scope file and Skills requests to a registered Workspace ID.

| Request | Result |
| - | - |
| `GET /api/workspaces`, `POST /api/workspaces` with `{path, name?}` | List or register local directories |
| `GET /api/workspaces/directories?path=...` | Browse local subdirectories for registration |
| `PATCH /api/workspaces/:id` with `{name}`, `DELETE /api/workspaces/:id` | Rename or remove a workspace entry |
| `PUT /api/workspaces` with `{ids}` | Reorder registered workspaces |
| `GET /api/navigation/events` | NDJSON snapshot followed by workspace and conversation updates |
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

Images (PNG/JPEG/GIF/WebP) go through Pi's image input and require an image-capable model. UTF-8 text attachments become message text. Limits: eight files, 6 MiB per image, 1 MiB per text file, 12 MiB total. Binary documents such as PDF/Office files are not parsed. Attachment content lives in the Pi conversation; there is no independent upload store. Git inspection requires the selected workspace to be the repository root and caps output at 512 KiB. “Files written this turn” lists successful built-in `write`/`edit` paths; Git changes show the entire working tree, including earlier edits and shell changes.

The file, Skill and approval endpoints return 404 when their corresponding plugin is disabled. Every enabled built-in Shell call requires approval. Requests expire after five minutes; stopping the run or server cancels pending approval. Approval permits the command under the existing shell policy. Reviewed local plugins remain trusted code; this is not a general-purpose containment mechanism.

## Message action and composer extensions

Browser-only local plugins may contain only `web.js` (optionally `plugin.json`). The built-in `session-helper` feature demonstrates a shared capability boundary: one manifest, one on/off switch and one Cordis lifecycle provide both Copy message and Edit & resend. Its backend registers the edit route, while both message actions are browser contributions.

The browser API exposes `messageAction({ id, label, icon, order?, visible(context), run(context) })`. `context.message` contains the Pi entry ID and the unmodified message content; `context.rawText` contains the original text. `context.leafId` identifies the active Pi branch. The host owns button styling, placement, ordering, error rendering and cleanup. A plugin must not mutate message DOM or inspect private conversation components. Actions are removed automatically when its Cordis scope is disposed.

Use `beginDraftMode({ title, text, submit(input) })` for a custom composer operation and `cancelDraftMode()` to leave it. The input contains text, attachments, chosen model and thinking level. An active mode intercepts the normal submit only while enabled. Disabling a plugin cancels its outstanding mode. The host owns the editor, cancel control and responsive layout.

The `session-helper` plugin submits to its authenticated route `POST /api/extensions/session-helper/revise`, passing `sessionId`, `sourceEntryId`, `expectedLeafId`, `message` and optional send parameters. The host checks an optimistic Pi leaf token, navigates the AgentSession tree and starts a run. Earlier branches remain in Pi JSONL. This does **not** roll back files written to the workspace. Existing branch selection/navigation UX is a separate concern.

## Co-located built-in capabilities

Each built-in feature owns its manifest, backend setup (if any), and browser setup (if any) under `features/<id>/`. `features/index.ts` is the sole built-in composition registry; it assembles a Cordis plugin from its manifest and host, while the browser loads the same manifest's `browser` URL. The TypeScript build includes `features/**/*.ts`, and npm ships `dist/features/` inside the single package.

Browser entries are served from `/features/<id>/client.js`. These are the **only** public JavaScript files in `dist/features`. Node-only host implementations and manifests are never exposed by the web server. Feature client imports targeting `../../web/...` resolve through a redirect to canonical application module paths. The loader owns frontend activation/disposal, and Cordis owns backend injection/disposal.

Do not add new files to the retired `src/builtins` or `web/builtins` trees. A new feature should be added to `features/<id>/` and registered once in `features/index.ts`.
