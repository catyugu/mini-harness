# mini-harness

mini-harness is a local Web harness for the [Pi coding-agent SDK](https://github.com/earendil-works/pi). It ships as one npm package, with [Cordis](https://github.com/cordiverse/cordis) managing tool registration and plugin lifecycles.

## Start

Requires Node.js 22.19 or later. To build from source:

```sh
git clone https://github.com/catyugu/mini-harness.git
cd mini-harness
npm ci
npm run build
node dist/bin/mini-harness.js --detached
```

Open the URL printed by the CLI. The local server listens on `127.0.0.1`. The browser takes the access token from the URL fragment and stores it for the tab. Configuration lives in `~/.mini-harness` by default and can be moved with `MINI_HARNESS_HOME`.

```text
mini-harness [--port 3837]
mini-harness --detached [--port 3837]
mini-harness status
mini-harness stop
mini-harness --help
```

One process owns each configuration directory. `status` reports the PID and URL. `stop` requests an authenticated, graceful shutdown. The CLI clears stale state when it can acquire the instance lock. Detached processes write to `server.log`. Both the log and `server.json` contain the access token.

## Models, Skills and sessions

- Select a model in the header or set its provider and ID in Settings. Pi reads credentials from `auth.json` or the environment and custom model definitions from `models.json`, both under the configuration directory.
- Pi loads Agent Skills from the global `skills/` folder and project `.mini-harness/skills/` folder. Toggle Skills from Settings.
- Subagents default to one child level and four concurrent child runs. Set the maximum depth to 0–8 and concurrency to 1–16. A child waiting for its descendants yields its execution slot. Explicit delegate arguments take precedence over child defaults and the parent's model. Provider-only calls select a model from that provider, and resolved child models are saved with their sessions.
- Conversation trees are scoped to the current workspace. Selecting a conversation for export includes its descendants, original Pi JSONL, and parent IDs. Deleting a conversation removes its descendants permanently. The index records pending file cleanup so the next start can finish an interrupted deletion.
- File tools restrict access to the workspace. Shell is disabled by default. Linux supports bubblewrap isolation. Trusted host mode and local JavaScript plugins use your user permissions. See [SECURITY.md](SECURITY.md).

## Plugins

Put reviewed local plugins in `~/.mini-harness/plugins/<id>/plugin.js`. IDs use lowercase letters, digits and hyphens, and start with a letter. An optional `plugin.json` can provide a title and description for the Settings screen.

```json
{ "title": "Conversation count", "description": "Give the model the number of conversations." }
```

The entry point is an ESM setup function. Declare needed Cordis services in `inject`. `harnessAgent.availableModels()` and `harnessSessions.get(id)` / `harnessSessions.list()` provide model and conversation metadata. `api.registerTool()` takes a Pi tool definition and returns an unregister function. Tool names must be unique and match the provider-compatible letters, digits, underscores and hyphens. Use `api.onDispose()` for resources owned by the plugin.

```js
export const inject = ['harnessSessions'];

export default function setup(ctx, api) {
  const config = api.defineConfig({ prefix: 'Count' }, (value) => {
    if (typeof value.prefix !== 'string') throw new Error('prefix must be a string');
  });

  api.registerTool({
    name: 'conversation_count',
    label: 'Conversation count',
    description: 'Count the conversations in the current workspace.',
    parameters: { type: 'object', properties: {} },
    async execute(_callId, _args, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: config.prefix + ': ' + ctx.harnessSessions.list().length }] };
    }
  });
}
```

Set individual plugin values in `settings.json` under `pluginConfig.<id>`. Enable installed plugins from Settings. Changes to tools or settings require idle conversations. Register tools during setup so each Pi session gets a consistent set, and keep plugin operations responsive to cancellation.

## Verification

```sh
npm run check
npx playwright install chromium --only-shell
npm run test:browser
npm run pack:check
```

The pack check installs the tarball into a clean project and runs the installed CLI, Web assets and a real Pi conversation against a mock provider. CI covers Node.js 22 and 24 on native Linux and Windows, with Chromium desktop and mobile viewport tests on Ubuntu.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
