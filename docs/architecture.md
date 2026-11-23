# Architecture

mini-harness ships as one npm package. Cordis composes services, browser contributions and their lifetimes. The official Pi SDK runs agents and owns messages, branches, context, compaction and steering and follow-up queues.

## Composition and lifecycle

The CLI prepares the private runtime directory and starts the HTTP adapter. The application root supplies platform paths, configuration, transport and the session-scope resolver. Capability descriptors in `packages/host/composition.ts` select the default services. Each capability keeps its implementation beside its own descriptor. `packages/kernel` resolves providers and manages Cordis fibers without importing product code. `packages/plugins` handles discovery, installation, configuration and graph publication.

Built-in and installed descriptors use protocol 2. The resolver validates required service dependencies, plugin dependencies, provider conflicts and cycles before setup. Optional services are live lookups. An explicit provider choice in `settings.json` selects a supported replacement before its consumers mount. File access, process execution and sandbox preparation are replaceable default services. Fixed providers include the principal Pi and session lifecycle owners. A local plugin can publish its own services or consume a declared existing service. The authenticated `GET /api/plugins/diagnostics` shows the resolved graph.

Configuration changes validate the candidate graph and schema defaults first. Modules load before existing fibers drain. Affected consumers dispose before providers, and providers mount before consumers. The host commits settings and publishes the browser graph after setup succeeds. A failure restores the previous fibers' setup and configuration. Work already cancelled during draining needs a new request. Unaffected fibers stay mounted. Registered routes and tools abort their in-flight requests and wait for cooperative cleanup.

Workspace scopes inherit application capabilities. Session scopes inherit the workspace, then their parent session scopes in order. The host lazily mounts only the plugins selected for those scopes. Cordis isolates locally owned services, and the tool registry computes visibility using the session ancestry. Scope policy can hide inherited tools. Deletion cancels descendant runs, releases their session scopes and then releases the workspace scope. Scoped service names must be distinct from inherited names. A scoped registration of a tool can override an inherited tool of the same name, subject to inherited restrictions.

## Data ownership

| State | Owner |
| - | - |
| Workspace IDs, canonical roots, labels and order | Workspace Catalog in `workspaces.json` |
| Session identity, title, workspace, parent and Pi file reference | Session Catalog in `sessions.json` |
| Messages, branches, context, model history and plugin records | Pi SessionManager in Pi JSONL |
| Steering and follow-up payloads | Pi AgentSession |
| Active runs, cancellation and restart checkpoints | Runs, with the latest checkpoint in `runs.json` |
| Pending approval requests | Approvals |
| Provider definitions and credentials | Pi model files in `models.json` and `auth.json` |
| Plugin selections, provider and scope overrides, appearance and default model | Settings in `settings.json` |
| Mounted graph and resource lifetimes | Cordis Plugin Host |
| Selected conversation and workspace, expanded branches and open panels | Browser UI |

The Pi Adapter is the only production capability that uses AgentSession and ModelRuntime directly. Its execution, catalog and administration contracts expose product types. Reading history and plugin records projects the active Pi branch without opening an executable AgentSession. The queue adapter tracks transient correlation and display metadata for queued attachments while Pi owns delivery. Observation, tool decisions and presentation transforms use Cordis events and Pi's public session subscription.

Runs keeps a bounded in-memory replay buffer. Reconnecting subscribers can resume from a cursor, and a stale cursor receives a Pi history projection and the current run view. A process restart marks previously queued or running checkpoints interrupted. Subagents use the same Catalog and Runs services and release their scheduler lease while waiting for descendants.

The catalog's deletion journal allows interrupted permanent deletions to finish at restart. Workspaces retain their project files when removed from mini-harness. The existing one-time index upgrade moves checkpoints into `runs.json` and preserves Pi histories.

## Files, execution and approval

The File Access provider is shared by the Pi file tools and the workspace browser. Both resolve workspace identity through the Catalog. The file capability adapts provider operations into Pi tool definitions and HTTP projections. Shell asks Approvals and submits a process request to the selected Process Execution provider. The default executor delegates isolated launch preparation to the Sandbox capability. See [Security model](../SECURITY.md).

## Browser composition

`GET /api/bootstrap` publishes successful browser entries from the same descriptors. The browser uses a separate Cordis context and mounts only the affected browser fibers when the graph changes. Slots, primitives, theme and responsive layout have distinct owners. Feature plugins contribute pages, navigation, tabs, composer controls and message actions through the frontend API. A disposed plugin loses its contributions, dialogs and pending API requests.

The authenticated `/api/changes` stream publishes revisions and scoped invalidations. Domain stores fetch authoritative projections on change and reconnect. Conversation-list updates request only the affected summaries when the revision is consecutive. The selected conversation loads its own Pi history and run replay. UI selection and panel state stay in the browser.

## Verification

Private `packages/<name>/package.json` files describe direct source dependencies. The root manifest owns dependencies and defines the single published package. Architecture checks enforce service declarations, module boundaries, browser asset exposure and the internal dependency graph.

- `npm run check` checks TypeScript and runs the Node suites.
- `npm run check:deps` runs the architecture checks.
- `npm run test:browser` runs the desktop, tablet and mobile Playwright journeys.
- `npm run pack:check` installs the tarball in a clean directory and checks public exports, browser assets, the CLI and Pi with a local mock provider.
