# Native session storage

mini-harness owns conversation history, branching, run state, queued input and
context replacements. The model adapter receives a projection of this history and does not
open or write session files.

## Files and ownership

`~/.mini-harness/sessions.json` is the conversation catalog. Each record
contains `id`, `workspaceId`, `parentId`, `title`, `titleSource` and `createdAt`.
Workspace identity is stored separately in `workspaces.json`; `workspaceId: null` means the conversation is independent of local workspace storage and tools.

Each conversation has one native JSONL file under
`~/.mini-harness/sessions/<workspace-hash>/<conversation-id>.jsonl`. The Session
Registry owns the writer and resolves this path from catalog identity. The shared SessionLogPort exposes durable record operations, not the file path or close operation. Unbound conversations use the `sessions/unbound/` directory. It does
not accept an arbitrary path from an API request. Session directories must remain
inside managed storage; symlinked directories, symlinked files, aliased hardlinks
and files replaced while open are rejected. New directories use mode `0700` and
new log files use `0600` where supported.

Original uploads are stored under `<conversation-id>/attachments/<sha256>` beside the JSONL file. The original name, MIME type, byte size and content identity are recorded in message or inbox presentation metadata. The store validates and flushes the uploads before acknowledging input; identical bytes share a file only within the same conversation. Historical model inputs remain in the log.

`RecordLog` owns the common durable envelope, sequence, ancestry, indexing, checksums and flush operations. `SessionLog` interprets native domain events, performs semantic validation and provides conversation projections. The log starts with a version 1 `session` header. Every later line contains a
native event, a monotonically increasing `seq`, a stable hexadecimal `id`, a
`parentId`, an ISO timestamp and a SHA-256 checksum. Native IDs contain 32
hexadecimal characters.

A `model-request` entry captures the native input before streaming without duplicating history.
Its parent identifies the active branch snapshot. The optional `messagesPatch` splices
only changed messages into that snapshot, including transforms and compaction inputs.
A content-addressed `tool-schema` record stores each distinct advertised tool list once
per conversation. Model requests refer to its SHA-256 hash via `toolSchema`.
`SessionLog.requestSnapshot(id)` reconstructs the validated exact model-visible
input for audit and retry. The session ID comes from the log header.

An `executor-response` diagnostic preserves the original model response when an executor translates it into the native protocol.

A `tool-execution` entry records a completed side effect before a model-visible result transform.
A successful transform commits a `tool-accepted` branch entry referencing the raw execution.
It saves only a reversible JSON splice when the content differs; an unchanged result stores no
second copy of the tool output. Projections and the model reconstruct the accepted content,
never the raw content. Tool executions, tool schemas and model requests are operational entries:
they do not advance the selected branch or appear as chat messages. A failed result transform
commits a safe error and preserves the original execution only for auditing.

## Appending and recovering

Each append writes one complete JSON record followed by a newline, then calls
`fsync` before returning. The in-memory projection advances only after that
write succeeds. A write failure closes the writer so a subsequent append cannot
hide a partial record. Creating or atomically replacing a log also synchronizes
its containing directory on platforms that support directory synchronization.

On open, the reader verifies the header, checksums, sequence, unique entry IDs,
event payloads and ancestry. A final record without its terminating newline is
an unacknowledged partial write. Writable recovery truncates it after the complete prefix has
been verified; read-only inspection validates and ignores the incomplete tail without modifying the file. Invalid complete lines, invalid checksums, unknown events and
invalid ancestry stop loading without rewriting the history.

Recovery converts unfinished work recorded in that log, including `queued`, `running` and `waiting` tasks, into a durable `interrupted` record.
It does not resume model requests or execute tools. Before a later agent turn,
Runs closes any unfinished tool calls with explicit interrupted results;
it never retries an unknown tool outcome automatically.

## Conversation branches and projections

The event stream has one append sequence and a selected conversation branch.
Messages, model choices, thinking settings, plugin records, context replacements and branch selections advance the conversation leaf. Run, inbox, model-attempt and session-setting records
advance only the sequence. Operational changes therefore cannot invalidate a
user's edit merely because a run was reserved or another input was queued.

A revision checks the browser's expected leaf, verifies that the target is a user
message on the selected branch, and starts a branch at that message's parent.
Selection itself is a durable event. Earlier branches remain in the same log for
history and export; they are excluded from subsequent model calls. Permanent
conversation deletion removes the entire log, including every branch.

The read projection exposes:

- `timeline`: the selected branch's visible messages and display records, plus applicable run terminations, with stable identities and presentation metadata.
- `contextMessages`: effective model messages after applying the branch's context replacements.
- `contextEntryIds`: source IDs aligned with model messages. A checkpoint uses its replacement record's ID.
- `model`, `thinkingLevel` and `leafId`: the selected branch's settings and identity.
- `run`: the latest operational run state, reduced in append order.

Pending input is read separately through `SessionLogPort.inbox()`; `queue()` also exposes failed deliveries for the UI. See [the source contract](../packages/sessions/src/log-api.ts) for the exact projection fields.

A `context-replace` event applies one or more ordered splices to the parent branch's effective model messages as one durable write. A splice can preserve source identities for one-for-one edits. Full history continues to use the original records. The effective context is updated incrementally as the branch advances and can be read without building the display timeline.

Model requests may record their measured input counts and budget. Model attempts record timing and provider-reported usage by request ID, separately from assistant messages. Conversation settings store plugin-owned values without advancing the branch; null removes a setting.

User presentation is stored separately from the accepted model input. Preparation can
change the model-visible content while the interface keeps the submitted text and
attachment labels. When preparation changes images, the presentation retains the
original images for display and editing. Accepted skill instructions are stored with
the model-visible input, so changing a skill file leaves prior turns intact. Assistant reasoning signatures, tool call
signatures, usage and opaque provider continuation metadata survive round trips
through the log.

## Durable inbox

All accepted messages are committed to the Session Log Inbox with a stable delivery ID and mode. Origin metadata identifies user input, agent and plugin messages, and task notifications. It can record the sender Session and Task. Consuming a message commits the model-visible record with the same delivery ID, so replay can reconstruct pending messages and conversation history together.

A durable pause persists Stop across restarts. The next user message clears the pause in the same acceptance record. Unpaused pending messages can start a new Run after settlement or startup. Cancelling a pending message writes an explicit acknowledgement and leaves its identity available for idempotency checks.

## Export and permanent deletion

Export uses document version 3 and includes conversation metadata and each full
native JSONL string in `log`, plus an `attachments` map of content identities to base64 originals. Selecting a parent includes its descendants. Active
conversations must be stopped before exporting, so each export is a coherent
snapshot.

Deletion first marks the selected tree as unavailable, drains registered participants and closes its writers. Sessions commits catalog removal together with a deletion journal, releases scoped configurations and instances, then removes the log files and owned attachment directories. Restart finishes any remaining journaled deletions. Deleting a workspace
cascades through its conversations while retaining the user's project files.
There is no archive state.

## Extension records and historical envelopes

Plugin records use a typed payload (`PluginRecord<Data>` / `SessionRecords<Data>`) in the same record log with an explicit owner (plugin ID and instance ID), data, and optional display metadata. The storage reader converts old custom record envelopes after validating their original checksums, retaining IDs, parents and payloads. An unscoped historical plugin record belongs to the application instance. Unmapped historical envelopes remain available as diagnostic records in native exports. New records use explicit plugin owners or diagnostic codes. The browser receives the explicitly supplied display data and the preceding message identity on the selected branch. Model context omits these records. Deleting its owning conversation removes both the records and private data for that session’s plugin instances.

## Retained tasks and retry identity

A failed run records the stable entry ID for its active input, including inbox deliveries. An explicit retry can retrieve that input from the native log. A null ID indicates the run failed before accepting the current submission. Older records with ambiguous input or missing attachment content require user input before resubmission.

File Preview reads stored attachment bytes through the conversation attachment endpoint. Workspace references remain part of the original user text and resolve through File Access when opened.

Independent work submitted with the explicit `harnessSessions.task(sessionId)` binding adds operational `task` records to the same log. The task ID is independent of record identity. State transitions do not move the conversation branch. Terminal records can include a compact result projection and bounded output with absolute byte cursors; ordinary inline tool results remain in the existing tool execution/acceptance records. Runs use the same task record with a small `run` object containing only input identity, replay sequence and changed files. Run lifecycle is projected from the task snapshot, and the final answer remains in the message log. Existing run envelopes are readable for historical conversations. On recovery, an unfinished task is marked `interrupted` and never automatically executed again.
