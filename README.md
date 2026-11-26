# mini-harness

A minimal local Web harness with a native Agent, shipped as one npm package. Product plugins compose directly through a [vendored Cordis runtime](vendor/cordis/README.md) shared by the server and browser. The [Pi model transport](https://github.com/earendil-works/pi) supports model providers behind a harness-owned adapter; mini-harness owns execution and conversation state.

## Start

Requires Node.js 22.19 or later. Install the package:

```sh
npm install -g mini-harness
mini-harness --detached
```

To run from source, use `pnpm install --frozen-lockfile && pnpm run build`, then `node dist/bin/mini-harness.js --detached`.

Ordinary foreground startup opens the browser; use `--no-open` to keep it closed. Detached startup prints the URL without opening a browser. The server listens on `127.0.0.1`; the browser keeps the access token in tab storage. Configuration lives in `~/.mini-harness`, or `MINI_HARNESS_HOME`.

```text
mini-harness [--cwd path] [--port 3837]
mini-harness --detached
mini-harness --no-open
mini-harness status
mini-harness stop
```

One process owns each configuration directory. An open tab reconnects after a restart on the same port and configuration directory. Run `mini-harness reset-token` to stop the instance and revoke its browser credential. `mini-harness status` lists conversation-log errors discovered when a conversation is opened or searched.

## Use

- Choose a configured model under the message input. The next main conversation message uses the global selection; sending remembers the actual model across navigation and restarts. Child agents have their own inherited or explicit model and do not change that selection.
- Add or edit a provider in Settings → Model. API keys are stored privately in `auth.json`; custom endpoints and model definitions live in `models.json`. Credential status reports local configuration. The provider validates access when a request is made.
- Register local directories from Workspaces in the sidebar. Browse or start conversations in any registered directory while other conversations keep running. Removing a workspace deletes its conversation trees and histories while preserving the directory and project files.
- Open the workspace panel to browse folders, preview files, inspect Git changes and view paths written by the current turn. Each workspace keeps its own open tabs across conversation switches.
- Paste images, drop files, choose the attachment button or type `/file` to upload local files (up to 8 files, 6 MiB each and 12 MiB total per message). Uploads are stored with the conversation and deleted with it. Image-capable models receive supported images; UTF-8 files up to 1 MiB become message text. Other files are available to enabled Shell commands via `MINI_HARNESS_ATTACHMENTS` (read-only in isolated mode). Use `@` to reference workspace files without copying them and `/` to discover skills and commands.
- While a task runs, queue a message. Settings → General → Add instructions controls whether queued messages steer the running task or follow up after its current answer. The native inbox commits it before acknowledging it. Steering takes effect at the next safe boundary and skips tool calls that have not started; follow-ups run after the current answer. Identical text and different attachments retain distinct delivery identities.
- New conversation stays a draft until the first send. Search and rename conversations, copy messages, retry errors, and edit/resend from a persisted message. A revision creates a new active branch; exports retain every branch.
- Refreshing, disconnecting or changing conversations leaves tasks running. Reopen a conversation to reconnect, or use Stop to cancel it and its descendants. Restart marks unfinished runs interrupted; acknowledged pending inbox items remain visible and are consumed by a later explicit run. Unknown tool outcomes are never automatically retried.
- Child agents default to one level and four concurrent executions. Plugins → Subagents exposes depth 0–8 and concurrency 1–16. A provider/model selected by the delegating model overrides registered child defaults, which override the parent model. A child awaiting descendants yields its slot. Lowering concurrency lets existing work finish before admitting more children.
- Expand the conversation tree to view children. Use checkboxes for bulk export or permanent deletion. Selecting a parent includes descendants. Export contains native JSONL and metadata; deletion cancels the selected trees, waits for their runs, and removes their files.
- Toggle Files, Skills, Subagents, Shell, Session helper and installed plugins. Session helper owns message copy and edit/resend under one switch. Changes to tool availability are reflected at the next model turn. Unloading a tool revokes its outstanding calls; unrelated runs continue.

Skills scans four directories in ascending priority.

1. `~/.agents/skills/`
2. `~/.mini-harness/skills/` or `$MINI_HARNESS_HOME/skills/`
3. `<workspace>/.agents/skills/`
4. `<workspace>/.mini-harness/skills/`

The highest-priority valid skill wins when names match. Skill directories and `SKILL.md` can be links, including links to locations outside the workspace. Use `/skill:name` to attach instructions to your message. Models can use `load_skill` while Skills is enabled. Native prompts also read regular, unlinked `AGENTS.md` files in the configuration directory and workspace root. Skills discovery and all instruction reads have size and resource limits.

Long conversations compact automatically. Manual compaction keeps two recent turns plus a summary for model context while preserving all message identities and history. Advanced users can set `maxTurns` (default 128) in `core:agent` and `autoCompact` (default `true`) in `core:compaction` in `cordis.patch.yml`.

Conversation permissions can be changed at any time from the left side of the composer. Read-only selects tools that declare read-only access, including built-in file reading, search and skill loading. It applies to descendant conversations. Standard applies the regular tool and approval rules. Full access bypasses per-command Shell approval while inherited read-only mode still applies. Choosing Full access also releases Shell approvals already pending in that conversation. The choice persists per conversation and applies to calls that have not started. Shell starts disabled and, unless a conversation is set to Full access, asks for approval for every command. File tools restrict access to the active workspace; Linux isolated Shell requires bubblewrap and `prlimit`. Trusted host Shell and reviewed JavaScript plugins run with your user permissions. See [SECURITY.md](SECURITY.md).

## Develop

Plugins use native Cordis modules. npm plugins can expose their server entry through standard package exports and optionally supply presentation metadata. Services can be replaced by enabling entries at application, workspace and nested session scopes. Third-party plugins can register tools, record progress, run child conversations, request confirmations and add keyed browser components. The standalone [Task notes example](docs/examples/task-notes) uses both SDK entry points. Parent and sibling scopes retain their own providers. See the [architecture](docs/architecture.md), [plugin guide](docs/plugins.md), [scoped provider examples](docs/scoped-providers.md), and [session log reference](docs/session-log.md).

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:node
pnpm exec playwright install chromium --only-shell
pnpm run test:playwright
pnpm run pack:verify
```

Each private package has a README covering its purpose, interfaces, configuration and tests. Start from the [package directory](packages/) or the [Web Profile](profiles/web.yml).

The test suites cover native execution, persistence, plugin lifecycles, model providers, file policy, shell approval, and desktop, tablet and mobile browser workflows. Each verification command above reuses the strict build. The local shortcuts `pnpm test`, `pnpm run test:browser` and `pnpm run pack:check` include a build. Use `pnpm run typecheck` for a compile-only check. The package check installs the tarball in a clean project, exercises the plugin SDK and runs a detached server against a local mock model.

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Profiles and development

The default Web app is composed from the base and Web bundles in the independent package at `~/.mini-harness/profiles/web/`. Each Profile has a package manifest, a fixed Cordis root and a user patch. See [Profiles](docs/profiles.md) for package initialization, module resolution and configuration.

The workspace panel has separate **Workspace files** and **Git changes** entries. Click a text attachment to open it in the workspace panel, or a photo or video to open a media dialog. Workspace file references from `@` completion open in the panel.

Use `pnpm install --frozen-lockfile` to install dependencies, `pnpm run build` to compile, `pnpm run format` to apply formatting, and `pnpm run check` to verify formatting and run the Node tests.

CI runs `format` once before the Node and browser jobs. A formatting failure blocks those jobs. The independent Autofix workflow runs alongside CI on same-repository pull requests (except Dependabot). It formats the exact PR head, verifies the result, and pushes a formatting-only commit to the PR branch only when tracked files change. A clean tree produces no commit, so the subsequent PR event does not cause a push loop. Fork PRs and pushes to `main` are check-only. A concurrent push is not overwritten.

Require the `format` status check in the `main` branch rules to enforce this gate at merge time. Configure the Actions secret `FORMAT_AUTOFIX_TOKEN` with a fine-grained personal access token with Contents write access (and Workflows write access if formatting changes workflow files). This allows the autofix push to trigger CI automatically on the new PR head. A missing or invalid token fails writeback rather than falling back to the built-in token.
