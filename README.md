# mini-harness

A minimal local Web harness for the [Pi coding-agent SDK](https://github.com/earendil-works/pi), shipped as one npm package. [Cordis](https://github.com/cordiverse/cordis) manages services, tools and plugin lifecycles.

## Start

Requires Node.js 22.19 or later. Install the published package:

```sh
npm install -g mini-harness
mini-harness --detached
```

For the v0.3.0 source preview, run `npm ci && npm run build`, then `node dist/bin/mini-harness.js --detached`.

Ordinary foreground startup opens the browser; use `--no-open` to keep it closed. Detached startup prints the URL without opening a browser. The server listens on `127.0.0.1`; the browser keeps the access token in tab storage. Configuration lives in `~/.mini-harness`, or `MINI_HARNESS_HOME`.

```text
mini-harness [--cwd path] [--port 3837]
mini-harness --detached
mini-harness --no-open
mini-harness status
mini-harness stop
```

One process owns each configuration directory. Detached processes write to `server.log`; both that log and `server.json` contain the access token. `stop` requests graceful shutdown.

## Use

- Choose a configured model under the message input. The next main conversation message uses the global selection; sending remembers the actual model across navigation and restarts. Child agents have their own inherited or explicit model and do not change that selection. Pi manages model switching and conversation context.
- Add or edit a provider in Settings → Model. Pi stores API keys in `auth.json` and custom endpoints and model definitions in `models.json`. Credential status reports local configuration. The provider validates access when a request is made.
- Click the workspace path to switch between local directories while tasks are idle. Conversation indexes stay separate; other open tabs must reload after a switch.
- Paste images, drop files or use the attachment button. Image-capable models receive native image input; UTF-8 files become message text. Use `@` to find workspace files and `/` to discover Skills.
- Open Workspace files for a file tree, bounded preview, Git diff and paths written by the current turn.
- While a task runs, choose Add instruction or Follow up and Queue the next message. Pi delivers it after the current tool batch or task.
- New conversation stays a draft until the first send. Search and rename conversations; copy messages, retry errors, and delete individual conversation trees.
- Refreshing, disconnecting or changing conversations leaves tasks running. Reopen a conversation to reconnect, or use Stop to cancel it and its descendants. Server shutdown cancels runs; a restart marks unfinished runs interrupted and restores their saved history.
- Child agents default to one level and four concurrent executions. In Plugins → Subagents, set depth 0–8 and concurrency 1–16. Explicit delegate models override child defaults, which override the parent model. A child awaiting descendants yields its slot. Lowering concurrency lets existing work finish before admitting more children.
- Expand conversation trees to view children. Selecting a parent for export includes descendants and original Pi JSONL. Permanent deletion cancels the selected trees, waits for their runs, and removes their files.
- Toggle workspace files, native Skills, subagents, Shell and local plugins in Plugins. Pi loads Skills from global `skills/` and project `.mini-harness/skills/` folders. Theme and scheduling settings apply during runs; changing active tools or Skills requires idle conversations.

Shell is disabled by default and requests approval for each command when enabled. File tools retain workspace access checks; existing Linux shell isolation is unchanged. Trusted host Shell and reviewed JavaScript plugins run with your user permissions. See [SECURITY.md](SECURITY.md).

## Develop

See [plugin development](docs/plugins.md) and [changes](CHANGELOG.md).

```sh
npm ci
npm run check
npx playwright install chromium --only-shell
npm run test:browser
npm run pack:check
```

CI covers native Windows/Linux and Node.js 22/24, Chromium desktop/tablet/mobile flows, and a clean tarball installation with the real Pi SDK against a local mock provider. No live provider credentials are needed for tests.

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
