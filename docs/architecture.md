# Architecture

The Web application is assembled from [YAML Profile entries](profiles.md) and Cordis plugins. The launcher provides a context, process controls and paths. It resolves the requested modules and starts an Entry Tree. The Web HTTP listener and browser gateway are Profile plugins with their own dependencies.

| Boundary | Responsibilities                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| Profile  | Entry identities, module resolution, configuration layers, and browser projections                             |
| Cordis   | Contexts, service isolation, injection, Entry Tree reconciliation, Fiber activation, typed events and disposal |
| Product  | Conversation identity and persistence, Agent execution, tool authorization, transport, and UI                  |

Shipped and installed plugins declare `inject`, `provide` and `apply(ctx, config)`. Shipped modules export the actual Cordis plugin and separate optional presentation metadata; browser-only entries do not allocate a server Fiber. Cordis activates consumers when the requested services are available. Workspaces and Sessions own identity and ancestry, and the plugin manager represents scoped entries as Cordis Contexts and Entry Groups. The browser loads its entries with the same Cordis implementation.

## Configuration and lifecycle

The Profile composition owner serializes configuration edits and applies each candidate to the Entry Tree before persisting it. A rejected candidate restores the prior entries. Run startup waits for scope preparation. Active runs release their work with the owning Fiber, and unloaded tool registrations invalidate their leases. Live configuration can update a running Fiber, and configuration subscribers read committed values from the owning Entry. Nested fibers keep their own lifetime while reading their Entry's configuration.

Each activation has an abort signal. Teardown aborts and drains work registered with `fiber.run()` and then releases effects. Cordis retains injected services while dependents dispose. Transport routes, long-running work and browser views also have lifetimes owned by their domains.

## Execution

Tasks supplies the common asynchronous runtime. A caller starts one task and chooses whether to await its handle; the resource owner and executing Cordis fiber constrain its lifetime. Runs supplies session admission and durable Run projections, Tools supplies model protocol delivery, and Subagents supplies recursion and capacity policy. The optional task-control plugin operates on any task. Shell streams process output into the tool task. Sessions persists retained task facts and recovers interrupted work without retaining historical execution handles.

## File interaction

File Access opens an explicit directory and enforces path containment. Workspace routes and Agent tools resolve the directory and scoped service before opening it. Files and Shell publish changes with workspace IDs as projection resource IDs. Files owns file browsing, search and composer completion. File Preview renders workspace resources, stored attachments and draft bytes. Git Diff owns the Git changes list and diff tabs. Sessions owns the stored attachment bytes and their conversation identity.

Layout registers typed views and opens tabs by their stable key and workspace owner. File Preview renders the selected resource in a tab or a media dialog. Conversation keeps the normalized reference in raw draft and history text while rendering it as an inline action.

## Plugin SDK

The single npm package exports Cordis and domain contracts directly, including `mini-harness/agent`, `mini-harness/llm`, `mini-harness/tools`, `mini-harness/tasks`, `mini-harness/runs`, `mini-harness/sessions` and `mini-harness/ui-slots`. Plugins import the services and events they consume. Browser modules use an import map restricted to public browser-safe modules.

See the [plugin guide](plugins.md), [scoped providers](scoped-providers.md) and [session log](session-log.md).
