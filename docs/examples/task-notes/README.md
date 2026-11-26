# Task notes

This standalone TypeScript plugin records progress in the active conversation branch. Its browser entry contributes a settings field and renderers for saved notes and tool results. The server also demonstrates protected plugin storage, approvals and a request-bound child run.

## Build and activate

Copy this directory into an independent project named `task-notes`. Its package.json declares the public `mini-harness` peer dependency and TypeScript build. Install dependencies and compile both entry points:

```sh
npm install
npm run build
npx mini-harness docs-task-notes --from-default-profile web --dump-config
```

Choose a fresh Profile name: `--from-default-profile` replaces that Profile's directory. In the generated `~/.mini-harness/profiles/docs-task-notes/cordis.patch.yml`, add:

```yaml
plugins:
  - id: task-notes
    name: /absolute/path/to/task-notes
    client: true
    live: true
```

Keep the Entry ID `task-notes` for this example because its server records use that explicit owner. Start with `npx mini-harness --profile docs-task-notes`. Configure a tool-capable model, send a parent conversation message, and ask it to save a task note. Change **Task note label** under Settings → Extensions; new notes use the accepted label. A blank label is rejected.

## Try the server capabilities

These authenticated endpoints are relative to `/api/extensions/task-notes`. [Transport](../../../packages/transport/README.md) documents the request contract.

| Method and path          | Input and effect                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /credential`        | Accepts a nonempty `token`, stores it with the plugin secrets service and reports credential presence.                                                                                          |
| `GET /smoke`             | Reports the current label, instance setup state and credential presence.                                                                                                                        |
| `POST /follow-up`        | Accepts `parentId`, `message` and optional `requireApproval`. Resolves the parent's committed model, creates a child and waits for its result. Returns `childId`, `runId`, task state and text. |
| `POST /cancel-follow-up` | Accepts `runId`. Cancels a known task only when its `origin` metadata identifies this example; reports whether cancellation was requested.                                                      |

The follow-up route passes its request signal to Runs. Closing that request cancels its child work. This differs from the independently owned built-in Subagents plugin. The [child-run cookbook](../../cookbook/adding-a-subagent-provider.md) explains how to select the required lifetime.

Disable the plugin to release its tool, routes and browser contributions. Previously committed records remain in the conversation; the history view falls back to their saved display metadata after the custom renderer is removed. Stop the example with `npx mini-harness stop`.

## Read the implementation

[plugin.ts](plugin.ts) contains the schema, scoped tool factory, prompt contribution, private data/secrets and route examples. [web.ts](web.ts) binds the Entry configuration and registers record/tool renderers. [plugin.json](plugin.json) adds optional display metadata. No private workspace imports are required.

The existing package verification builds this example against the installed SDK, packs it, installs it into a Profile and verifies activation, configuration, execution and removal. See [development](../../development.md) for the `pack:check` command and [SDK packaging](../../plugins.md) when adapting the example.
