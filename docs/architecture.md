# Architecture

mini-harness has two layers. Product plugins and their Node.js and browser entry points sit above the shared Cordis runtime in [vendor/cordis](../vendor/cordis/README.md).

| Layer | Responsibilities |
| --- | --- |
| Product | Sessions, Runs, Agent, Tools, file access, settings, transport, and UI services. The host supplies configured plugin entries, module resolution, scope addresses and persistence. |
| Cordis | Context and service inheritance, dependency injection, the Entry Tree, Fiber activation and disposal, typed events and effects. |

The runtime has no product dependencies. Workspaces and Sessions own domain identities and ancestry. The plugin manager turns those addresses and user selections into Cordis contexts and Entry Tree entries. Cordis isolates selected services in a child context and activates consumers when their injected services are available. The browser owns a separate Context and uses the same Entry Tree with URL-based module resolution.

## Service composition

Internal and installed plugins declare `inject`, optional `provide`, and `apply(ctx, config)`. Cordis registers each entry as a Fiber, invokes it when dependencies are available, and removes its effects when the Fiber deactivates. The plugin manager handles discovery, package installation, metadata and product-level provider selection. Diagnostics use Entry and Fiber state.

Plugins collaborate through services, typed events and domain registries. Tool registration belongs to Tools, prompt sections to Prompt, session records to Sessions, and DOM outlets to UI Slots. Services that use a caller's identity derive it from the Cordis call context and the host-assigned entry.

## Configuration and lifecycle

Settings persists `~/.mini-harness/settings.json`. It supplies a candidate configuration to the host and writes it after required services and configuration validators succeed. An unsuccessful transaction restores the previously committed entries. Runs guards structural changes to the application or affected scopes while conversations are active. A plugin may accept live configuration using the Fiber update event.

An activation owns an abort signal. Teardown aborts and drains work registered with `fiber.run()` before releasing effects. Cordis retains injected services while dependent fibers dispose. Runs, transport requests and views retain their own domain state and cancellation rules.

## Domain boundaries

- Runs admits and schedules executions. Agent owns the model and tool pipeline. Sessions owns the event log, attachments, branching, recovery and deletion.
- Tools checks registration, argument schemas and authorization at execution. Approvals resolves user decisions and provider-specific execution remains behind process and sandbox services.
- Transport owns authenticated routes and revisions. UI Gateway publishes bootstrap entries and change notices. UI Layout owns the view hierarchy, UI Slots owns outlet registration, and browser feature plugins own their controls and projections.
- The root npm tarball publishes the CLI and three public subpaths: `mini-harness/cordis`, `mini-harness/plugin`, and `mini-harness/browser-plugin`. Built-ins and the SDK use the same Cordis source.

See the [plugin guide](plugins.md), [scoped providers](scoped-providers.md) and [session log reference](session-log.md).
