# mini-harness

A minimal local Web harness with a native agent kernel, shipped as one npm package. [Cordis](https://github.com/cordiverse/cordis) composes services, tools and plugin lifecycles. The [Pi model transport](https://github.com/earendil-works/pi) supports model providers behind a harness-owned adapter; mini-harness owns execution and conversation state.

## Start

Requires Node.js 22.19 or later. Install the package:

```sh
npm install -g mini-harness
mini-harness --detached
```

To run from source, use `npm ci && npm run build`, then `node dist/bin/mini-harness.js --detached`.

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

- Choose a configured model under the message input. The next main conversation message uses the global selection; sending remembers the actual model across navigation and restarts. Child agents have their own inherited or explicit model and do not change that selection.
- Add or edit a provider in Settings → Model. API keys are stored privately in `auth.json`; custom endpoints and model definitions live in `models.json`. Credential status reports local configuration. The provider validates access when a request is made.
- Register local directories from Workspaces in the sidebar. Browse or start conversations in any registered directory while other conversations keep running. Removing a workspace deletes its conversation trees and histories while preserving the directory and project files.
- Open the workspace panel to browse folders, preview files, inspect Git changes and view paths written by the current turn. Each conversation keeps its own open tabs.
- Paste images, drop files or use the attachment button. Image-capable models receive image content; UTF-8 files become message text. Use `@` to find workspace files and `/` to discover skills.
- While a task runs, choose Add instruction or Follow up and queue a message. The native inbox commits it before acknowledging it. Steering takes effect at the next safe boundary and skips tool calls that have not started; follow-ups run after the current answer. Identical text and different attachments retain distinct delivery identities.
- New conversation stays a draft until the first send. Search and rename conversations, copy messages, retry errors, and edit/resend from a persisted message. A revision creates a new active branch; exports retain every branch.
- Refreshing, disconnecting or changing conversations leaves tasks running. Reopen a conversation to reconnect, or use Stop to cancel it and its descendants. Restart marks unfinished runs interrupted; acknowledged pending inbox items remain visible and are consumed by a later explicit run. Unknown tool outcomes are never automatically retried.
- Child agents default to one level and four concurrent executions. Plugins → Subagents exposes depth 0–8 and concurrency 1–16. A provider/model selected by the delegating model overrides registered child defaults, which override the parent model. A child awaiting descendants yields its slot. Lowering concurrency lets existing work finish before admitting more children.
- Expand the conversation tree to view children. Use checkboxes for bulk export or permanent deletion. Selecting a parent includes descendants. Export contains native JSONL and metadata; deletion cancels the selected trees, waits for their runs, and removes their files.
- Toggle Files, Skills, Subagents, Shell, Session helper and installed plugins. Session helper owns message copy and edit/resend under one switch. Changes to tool availability are reflected at the next model turn. Unloading a tool revokes its outstanding calls; unrelated runs continue.

Skills load from `~/.mini-harness/skills/` and `<workspace>/.mini-harness/skills/`; a workspace skill takes precedence over a global skill with the same name. `/skill:name` expands a skill explicitly, and the `load_skill` tool lets a model load listed skills even when Files is disabled. Native prompts also read `AGENTS.md` in the configuration directory and workspace root. Skill and instruction reads are bounded and reject linked files.

Long conversations compact automatically. Manual compaction keeps two recent turns plus a summary for model context while preserving all message identities and history. Advanced users can set `pluginConfig["core:agent"]` with `maxTurns` (default 128) and `autoCompact` (default `true`).

Shell starts disabled and asks for approval for every command. File tools restrict access to the active workspace; Linux isolated Shell requires bubblewrap and `prlimit`. Trusted host Shell and reviewed JavaScript plugins run with your user permissions. See [SECURITY.md](SECURITY.md).

## Develop

Each local plugin bundle has a `plugin.json` descriptor and a server or browser setup function, or both. Services can be selected at application, workspace and nested session scopes. Parent and sibling scopes retain their own providers. See the [architecture](docs/architecture.md), [plugin guide](docs/plugins.md), [scoped provider examples](docs/scoped-providers.md), and [session log reference](docs/session-log.md).

```sh
npm ci
npm run check
npx playwright install chromium --only-shell
npm run test:browser
npm run pack:check
```

The test suites cover native execution and persistence, provider adapters with local HTTP mocks, plugin lifecycles, file policy, shell approval, detached CLI startup, and Chromium desktop/tablet/mobile journeys. `pack:check` installs the single tarball into a clean project and checks public exports, assets, CLI and a model/tool-independent chat roundtrip. No live model credentials are needed.

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
