# Architecture

mini-harness ships as one npm package. Cordis composes capabilities and manages their lifetimes. The official Pi SDK runs agents, talks to model providers, and manages conversation history and context.

## Capability descriptors

Each built-in capability declares its descriptor in its own directory. The host composition root imports those descriptors. A descriptor can declare server setup, a browser entrypoint, a configuration schema, required and optional services, and the services it provides. Features that the app needs at startup use the same mounting path as user-switchable features.

The catalog resolves required service dependencies against the enabled providers. Each service has at most one enabled provider in the application context. A workspace or conversation ID scopes access to services that manage resources for more than one workspace or session. The browser graph uses the same descriptors and contains the entries published after server setup succeeds. Built-ins can declare additional browser dependencies for the layout and contribution points they use.

The Cordis kernel mounts providers before consumers and disposes consumers before providers. The plugin runtime validates the candidate graph and configuration before applying a change. It publishes the resulting browser graph after the settings write succeeds. On a failed change, it restores the previous mounts. During startup an optional failure is visible in the plugin catalog, and the rest of the app can start.

Configuration schemas define plugin defaults. Settings persists user overrides and owns the global model choice. Most plugin configuration changes remount the affected capability. Subagents uses committed policy for new delegations while keeping one scheduler for active children and queued work. Tool registrations have their own cancellation and cleanup. On disposal, the registry removes the tool from future agent sessions, aborts invocations of that tool, and waits for their cleanup. Other runs can continue. Pi refreshes an idle AgentSession's tools and Skills when opening it for new work.

## Data ownership

| State | Owner |
| - | - |
| Workspace IDs, roots, labels, and order | Workspaces, in `workspaces.json` |
| Session identity, title, workspace reference, and parent relationship | Session Catalog, in `sessions.json` |
| Messages, branches, model history, thinking level, and input metadata | Pi SessionManager, in Pi JSONL |
| Steering and follow-up queues | Pi AgentSession |
| Active runs, cancellation, and restart checkpoints | Runs, with the latest checkpoint in `runs.json` |
| Pending approval requests | Approvals |
| Provider definitions and credentials | Pi ModelRuntime, in `models.json` and `auth.json` |
| Plugin switches, configuration overrides, appearance, and default model | Settings |
| Mounted plugin state | Plugin runtime |
| Selected conversation and workspace, expanded branches, and open panels | Browser UI |

The Session Catalog resolves workspace paths through Workspaces and keeps a reference to the Pi file. Reading a conversation projects the active Pi branch from memory or the file without opening an executable AgentSession. Run streaming keeps a bounded in-memory replay buffer. A restart marks queued or running checkpoints interrupted and uses the existing Pi history for replay. Text attachment content is part of the Pi user message, while the message's attachment metadata records names and media types for display. Titles are derived from the original input.

Deleting a session reserves its subtree, waits for Runs and Pi to release it, then permanently deletes its Pi histories. A small journal allows an interrupted deletion to finish at restart. Workspace deletion uses the same cascade and preserves the project directory. At startup the one-time index upgrade moves existing Run checkpoints to their own file and rewrites the catalog records in the new format.

## Browser composition

`GET /api/bootstrap` returns the mounted plugin graph. The browser owns one read-only projection per domain, shared by the components that need it. The authenticated `/api/changes` stream sends revisions and scoped invalidations. The stores re-read authoritative endpoints after a change or reconnect. Conversation history and stream replay are loaded by the selected conversation view.

The layout exposes slots, tabs, and page registration. Settings owns its pages, the composer owns input commands and completions, and the message contribution service owns tool renderers and message actions. The browser plugin loader binds those APIs to a Cordis scope, so disabling a plugin removes its contributions and cancels its requests. Feature views use the shared primitives, theme tokens, and responsive layout.

Workspace Files supplies constrained file access. File tools adapt that access to Pi, while the browser uses workspace-scoped inspection routes. Shell combines the Process Execution and Approvals services. Isolated execution requires a supported Linux host. Host execution requires explicit configuration and each command still requires approval.

## Verification

Private `packages/<name>/package.json` files declare direct internal imports using `file:../<name>` links. The root manifest and lockfile install dependencies and define the published package. Architecture checks cover package and capability dependencies, Cordis service declarations, and browser imports. Feature tests live under `packages/<name>/tests/`, with cross-capability tests under `test/`.

- `npm run check` runs TypeScript and Node tests.
- `npm run test:browser` runs the Playwright journeys.
- `npm run pack:check` installs the npm tarball into a clean directory and exercises the CLI, browser assets, and Pi.
