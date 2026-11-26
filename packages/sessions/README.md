# Sessions

Sessions owns durable conversation identity, ancestry, permissions, branch history, original uploads and deletion. It provides the persistence contract used by [Runs](../runs/README.md), [Tools](../tools/README.md) and external plugins. [Tasks](../tasks/README.md) owns live execution; stored task and run records are durable observations of that execution.

## Public API and usage

Import `mini-harness/sessions` for `SessionStore`, `SessionLogPort`, plugin records and the `harnessSessions` declaration. Browser-safe identity, run-state and display-record contracts have separate exports: `mini-harness/sessions/identity`, `mini-harness/sessions/run-state` and `mini-harness/sessions/display-record`.

A plugin declares `harnessSessions` in its injection list and obtains an existing session ID from its route or tool request. To store a branch-owned note:

```ts
import type { Context } from 'mini-harness/cordis';
import 'mini-harness/sessions';

export async function saveNote(ctx: Context, sessionId: string, text: string) {
  const records = ctx.harnessSessions.records<{ text: string }>(sessionId, {
    pluginId: 'notes',
    instanceId: 'notes',
  });
  return records.append({ text }, { kind: 'note', title: 'Saved note', source: ['data', 'text'] });
}
```

The owner pair identifies the contributor. `records().list()` returns that owner's records on the selected branch; it does not scan unrelated branches or owners. The [Task notes example](../../docs/examples/task-notes/README.md) shows a complete tool, saved record and browser renderer.

## Responsibilities and contracts

The [public contract](src/records.ts) groups four kinds of operation:

- Catalog and identity: create, list, rename, ancestry, workspace association, permissions and stable runtime scope keys. A conversation can exist without a workspace.
- History: projected timeline and selected leaf, read-only inspection, revision validation, diagnostics and latest durable run summary.
- Persistence: append through the log port, prepare and retain original input attachments, read stored attachments, and create owner-specific record access.
- Lifetime: availability checks, deletion participants, export and recursive deletion.

`log(id)` returns a record-operation port. The registry retains ownership of the underlying writer and its close/recovery lifecycle; plugins must not open a second writer for the same log. `inspectLog` supports observation without exposing writer ownership. History returns defensive projections rather than mutable backing records. The same log holds Inbox delivery IDs, message origins and the automatic wake pause.

`task(id)` supplies a Task `owner` and synchronous durable `commit` callback. It first opens or recovers the log so admission does not create work with an unavailable history owner. Pass that binding to `harnessTasks.start`; use the Tasks contract for retention, result projection, cancellation and waiting. Historical task lookup recovers observations by ID without recreating executable handles.

## Lifecycle and dependencies

The shipped `core:sessions` entry requires Profile scopes, Profile configuration and application paths. Workspaces is optional: bound conversations derive their root from that provider, while unbound conversations remain valid. Session scope ancestry follows parent sessions, then the workspace where present. The persistent storage path is derived from conversation identity, not whichever directory a caller currently selects.

`scope(id)` identifies the resource's standing composition; `runScope(id)` is its child identity used for execution contributions and observations. Callers should obtain these keys from Sessions rather than constructing an independent identity for the same conversation.

The separate `core:tool-policy` entry in [permission-policy.ts](src/permission-policy.ts) provides `harnessToolPolicy`. A `readOnly` conversation or ancestor restricts its descendants to tools tagged `readOnly`. Process lifetime and optional plugin confirmations belong to [Process Execution](../process-execution/README.md) and [Approvals](../approvals/README.md).

Optional Tasks integration registers durable history and a deletion participant that removes and drains every affected session owner. Other providers can register `beforeDelete` participants to quiesce their work. Workspace removal uses the same recursive conversation-deletion path.

Deletion first blocks affected conversations and descendants, then drains participants. It commits catalog removal and a cleanup journal before removing scoped Profile configuration and managed files. Startup completes a committed cleanup journal. Export refuses busy conversations and includes all branches and original uploads. Neither export nor deletion changes project directories.

Malformed logs are reported through diagnostics and isolated to their conversation. [Session log](../../docs/session-log.md) is the authoritative reference for record framing, durability, recovery, branch selection and export format.

## Implementation and testing

[registry.ts](src/registry.ts) owns access, writer caching and deletion. [record-log.ts](src/record-log.ts) owns durable framing; [log.ts](src/log.ts) and [projection.ts](src/projection.ts) interpret conversation records; [storage.ts](src/storage.ts) owns managed log and attachment paths.

[Log tests](tests/log.test.ts) cover branches, durable input, corruption and projections. [Registry tests](tests/registry.test.ts) cover deletion recovery, catalog validation, exports and writer ownership. [Task-history tests](../../test/system/task-history.test.ts) cover durable observations without live task reconstruction. See [session coordination](../../docs/subsystems/sessions.md) for how Runs and the browser consume this owner.
