# Local plugins

Install reviewed ESM code in `~/.mini-harness/plugins/<id>/plugin.js`. IDs start with a lowercase letter and contain lowercase letters, digits and hyphens (up to 64 characters). Plugins run with your user permissions. Enable them in Settings.

## Manifest and configuration

`plugin.json` supplies metadata, required plugins, and a JSON Schema for configuration:

```json
{
  "title": "Conversation count",
  "description": "Count conversations in the current workspace.",
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

Dependencies must be enabled; cycles and missing dependencies reject the configuration before unloading anything. Built-in IDs are `files`, `skills`, `subagents` and `shell`.

The GUI renders strings, booleans, numbers, integers, enums and nested objects from the schema. Other values use JSON input. Use `title`, `description`, `default`, `required`, bounds and `additionalProperties` to describe the accepted configuration. Keep schemas self-contained; external references are unsupported. Defaults apply recursively to object properties, then TypeBox validates the resulting value. Store configuration in `settings.json` under `pluginConfig.<id>`; it is ordinary local configuration, so use Pi credential storage for model secrets.

## Entry point

```js
export const inject = ['harnessSessions'];

export default function setup(ctx, api) {
  const { prefix } = api.config;
  api.registerTool({
    name: 'conversation_count',
    label: 'Conversation count',
    description: 'Count conversations in this workspace.',
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
| `api.registerTool(tool)` | Register a Pi tool; returns an async unregister function |
| `api.onDispose(cleanup)` | Register synchronous or asynchronous resource cleanup |
| Returned cleanup function | Alternative cleanup for the setup function |

Tool names must be unique, use letters, digits, underscores or hyphens, and be 1–64 characters long. Built-in coding-tool names are reserved even while the file plugin is disabled.

## Services and lifecycle

Public metadata services are `harnessAgent.availableModels()`, `harnessSessions.get(id)` / `list()`, and `harnessConfig.get()` / `paths`. The host also provides `harnessRuntime`, `harnessTools`, `harnessSkills` and `harnessWeb` for core composition; these are internal interfaces. The web service becomes available after plugin startup.

Built-in and local setup functions run in Cordis scopes. Dependencies mount first and unload last. Disabling a required plugin also requires disabling its dependents. Reconfiguring a dependency restarts its enabled dependents. Unchanged plugin scopes stay mounted.

Schema validation precedes setup. If setup or settings persistence fails, the host unloads new scopes and restores the previous plugin configuration. Cleanup handlers must release their resources and tolerate partial setup; failure to restore is reported explicitly. Changes affecting active tools or Skills require idle conversations, and invalidate Pi sessions so their next open gets the current tool definitions. Theme, scheduling, execution policy and model-selection changes preserve running sessions. Changes to child depth refresh tool availability when a session is next idle.

## Run API

All API requests require `Authorization: Bearer <token>`.

| Request | Result |
| - | - |
| `POST /api/sessions/:id/runs` with `{ "message": "...", "model": { "provider": "...", "id": "..." } }` | Starts a server-owned run; responds `202` with run ID and status. Model is optional. |
| `GET /api/sessions/:id/runs` | Latest run status, including terminal errors |
| `GET /api/sessions/:id/events?run=<run-id>&after=<sequence>` | NDJSON events after the cursor; disconnecting removes only this observer |
| `POST /api/sessions/:id/cancel` | Explicitly cancel that conversation and running descendants |

Run states are queued, running, completed, failed, cancelled and interrupted. Event replay is bounded to 2,048 events and approximately 1 MiB per active conversation. An older cursor receives a snapshot of Pi history and current output, then follows live events. Completed runs use saved history snapshots. The server persists latest status and Pi JSONL, rather than a separate execution context or an event archive.
