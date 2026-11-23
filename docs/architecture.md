# Architecture

mini-harness ships as one npm package. Cordis composes application, workspace and session capabilities. The native agent kernel owns turns, tools, queues and context; the Pi dependency is restricted to the model transport adapter. Public contracts, plugins, persisted logs and browser code contain no model SDK types.

## Composition and lifecycle

The CLI prepares the private runtime directory and starts the HTTP adapter. The application root supplies paths, configuration, routes, mutation serialization and the scope resolver. Capability descriptors in `packages/host/composition.ts` select the defaults. `packages/kernel` resolves providers and manages Cordis fibers without importing product code. `packages/plugins` owns discovery, installation, configuration and graph publication.

Built-in and installed plugins use the same descriptor fields and dependency resolution. Provider choice is explicit when a service would shadow an existing provider. Host infrastructure is protected. At application scope, replacing a multi-service plugin must account for all of its services. At descendant scopes, a plugin can shadow one inherited service while retaining the other parent services. The nearest selected provider wins; parents and siblings remain unchanged. Reusing the same plugin ID in a descendant still requires an explicit selection. Scoped ownership is qualified by scope, not only by plugin ID.

Workspace scopes inherit application services. A session inherits its workspace and each ancestor session scope. Services are isolated on the owning Cordis context. The native execution path resolves LLM, prompt, model and tool services from the current session scope. Tool policy also inherits through the entire ancestry; a child cannot re-enable a tool denied above it. Removing a local provider rebuilds the isolation boundary so its consumers see the parent again.

Configuration changes validate the candidate graph and schema defaults before setup. Modules load before affected fibers drain; consumers dispose before providers, and providers mount before consumers. Settings commit and browser graph publication occur after successful setup. A failure restores previous fibers and configuration. Work cancelled during draining needs another explicit request. Unaffected fibers stay mounted. Routes, tools and browser contributions revoke their leases and wait for cooperative cleanup when their owner unloads.

## State ownership

| State | Owner |
| --- | --- |
| Workspace IDs, canonical roots, labels and order | Workspace Catalog, `workspaces.json` |
| Session identity, title, workspace and parent | Session Catalog v3, `sessions.json` |
| Transcript, branch selection, model, thinking, compaction and plugin records | Native Session Log |
| Acknowledged inbox items and their delivery/cancellation | The same Session Log |
| Durable queued/running/terminal run state | The same Session Log |
| Active execution ownership and scope preparation | Agent Registry |
| Cancellation and bounded streaming replay | Runs |
| Pending command approvals | Approvals |
| Provider definitions and credentials | Model store, `models.json` and `auth.json` |
| Plugin selections, scope overrides, appearance and default model | Settings, `settings.json` |
| Service instances and resource lifetimes | Cordis Plugin Host |
| Selection, expanded branches and open panels | Feature-owned browser state |

The log is append-only, checksummed and newline framed. An append is acknowledged after fsync. Transcript events advance the selected branch; operational run and inbox events advance the durable sequence without changing that branch. History and context are separate projections: compaction reduces context while preserving visible messages and their revision targets. See [the session log reference](session-log.md).

## Native execution

`NativeAgent` obtains one execution owner per session and prepares its scope. Before committing input it resolves the model and validates capabilities. A turn builds a prompt, takes a snapshot of available tool definitions, streams a native assistant message from `LlmPort`, and commits that message. The built-in catalog, administration and LLM providers share a single model store. The model adapter is the only module importing `@earendil-works/pi-ai`. It converts native messages and opaque provider continuation data to the provider protocol and back; it does not own files, sessions or tools.

The tool pipeline checks call identity, JSON-schema arguments, registration lifetime and policy before execution. A duplicate call ID rejects the response before any side effect. A call executes the tool lease advertised for that turn, so hot replacement cannot redirect it to a different implementation. Tools are serial by default. Consecutive calls that explicitly opt in can overlap, and each result is committed before its completion event. Serial calls form barriers. An unload can revoke a lease; the resulting error is visible to the model. Approval and process execution remain separate capabilities.

The durable inbox assigns every message its own ID. Delivery commits the user message and its inbox acknowledgment atomically in one record. Steering is observed after generation and before launching tool calls; unstarted calls receive explicit skipped results before the steering message is delivered. Follow-ups are consumed after a final answer. Cancellation rejects pending work and records inbox cancellation. A process restart preserves pending inbox items and marks the run interrupted. The next explicitly started run closes unknown tool outcomes with error results rather than replaying them.

The prompt composes ordered sections for workspace identity, tool guidance, bounded `AGENTS.md` files and plugin contributions. The Skills plugin owns discovery, its prompt section, explicit `/skill:name` expansion and `load_skill`. It can unload independently. Text/image attachments are normalized once and stored with separate presentation metadata, so context expansion does not alter the user's displayed text or attachment identity.

Execution hooks compose turn context, the outbound model request and durable successful tool content. Retry policy runs before any model output has streamed and is bounded. Plugin state projections fold the current branch's custom records directly from the native log.

Compaction asks the selected LLM to summarize an older prefix and retains two recent turns. It commits a summary only after successful completion and cancellation checks. Existing message IDs and branch history remain available. Turn limits bound autonomous work. Subagents use the same session, execution and run services; their semaphore leases are yielded while awaiting descendants, permitting nested execution with one slot.

## Transport and recovery

Runs owns server-side work independently of HTTP subscribers. Its replay buffer is bounded by event count and size. A reconnect can resume from a cursor; a cursor older than the live buffer receives a durable history projection plus the current partial response and active tools. Completed runs can be read without recreating an execution instance. After restart, an interrupted run is terminal and no pending tool executes until new user work is submitted.

Session deletion records a durable journal after descendant runs have drained. Cleanup is repeated after a crash and removes only validated owned files. Deleting a workspace retains project files. The running application has one native storage and execution path.

## Browser composition

The server publishes successful browser entries from the same descriptors at `/api/bootstrap`. Browser boot owns only generic graph mounting, projection registration and the selected view switch. Domain stores belong to feature descriptors for sessions, workspaces, settings, models, plugins and approvals; the runtime contains no domain endpoint list or domain service whitelist.

The browser runs its own Cordis graph. Feature plugins contribute pages, navigation, tabs, composer controls and message actions. Keyed slot entries can replace a specific contribution and compose decorators around it. Each rendered entry and decorator has its own disposal signal. Plugin disposal also removes dialogs, subscriptions and pending requests. Slots, primitives, theme and responsive layout retain the existing desktop and mobile UI behavior.

The authenticated `/api/changes` stream publishes revisions and scoped invalidations. Registered domain owners fetch authoritative projections on change and reconnect. A failed owner is reported without preventing unrelated projections from refreshing. The selected conversation loads native history and run replay; presentation state stays local to its browser feature.

## Verification boundaries

Private `packages/<name>/package.json` files declare exact source dependencies; the root manifest defines the only published package. Architecture tests enforce the dependency DAG, declared services, SDK isolation, generic browser runtime and public asset boundaries.

- `npm run check` checks TypeScript and runs Node tests.
- `npm run check:deps` runs architecture checks.
- `npm run test:browser` runs desktop, tablet and mobile Playwright journeys.
- `npm run pack:check` installs the tarball in an empty project and checks exports, assets, detached CLI and native execution against a local mock model provider.
