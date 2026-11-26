# Native session storage

mini-harness owns conversation history, branching, run state, queued input and
compaction. The model adapter receives a projection of this history and does not
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
an unacknowledged partial write and is truncated after the complete prefix has
been verified. Invalid complete lines, invalid checksums, unknown events and
invalid ancestry stop loading without rewriting the history.

Startup converts a `queued` or `running` run into a durable `interrupted` record.
It does not resume model requests or execute tools. Before a later agent turn,
the agent closes any unfinished tool calls with explicit interrupted results;
it never retries an unknown tool outcome automatically.

## Conversation branches and projections

The event stream has one append sequence and a selected conversation branch.
Messages, model choices, thinking settings, plugin records, internal audit records, compactions, context
edits and branch selections advance the conversation leaf. Run and inbox records
advance only the sequence. Operational changes therefore cannot invalidate a
user's edit merely because a run was reserved or another input was queued.

A revision checks the browser's expected leaf, verifies that the target is a user
message on the selected branch, and starts a branch at that message's parent.
Selection itself is a durable event. Earlier branches remain in the same log for
history and export; they are excluded from subsequent model calls. Permanent
conversation deletion removes the entire log, including every branch.

The read projection exposes:

- `messages`: the selected branch's original conversation messages, with stable
  entry identities and presentation metadata.
- `contextMessages`: the model transcript after the latest applicable compaction
  and context edits.
- `contextEntryIds`: source IDs aligned with model messages, including the
  compaction event ID for a summary.
- `model`, `thinkingLevel` and `leafId`: the selected branch's settings and identity.
- `run` and `inbox`: the latest global operational state, reduced in append order.

Compaction stores a summary and a retained-entry boundary. It changes model
context without deleting or renumbering the visible conversation. Context edits
can replace or omit a message's contribution to model context while preserving
the original message in the conversation projection. Plugin records have a single explicit instance owner and follow the selected branch.

User presentation is stored separately from the accepted model input. Preparation can
change the model-visible content while the interface keeps the submitted text and
attachment labels. When preparation changes images, the presentation retains the
original images for display and editing. Accepted skill instructions are stored with
the model-visible input, so changing a skill file leaves prior turns intact. Assistant reasoning signatures, tool call
signatures, usage and opaque provider continuation metadata survive round trips
through the log.

## Durable inbox

Runs admits steering and follow-ups while Agent accepts input for the active run. Queued input receives a stable delivery ID. Enqueue is acknowledged only after Sessions makes the event durable. Delivering it appends one user
message that also names the inbox ID; message creation and delivery
acknowledgement therefore share one durable record. An already consumed delivery
ID cannot create a second user message.

An interrupted or failed run leaves undelivered input visible. Restart does not
execute that input by itself. A subsequent explicit run can consume it. Explicit
cancellation records the cancelled delivery IDs and removes them from the pending
projection. No content-string matching or process-local queue is needed to
reconstruct delivery state.

## Export and permanent deletion

Export uses document version 3 and includes conversation metadata and each full
native JSONL string in `log`, plus an `attachments` map of content identities to base64 originals. Selecting a parent includes its descendants. Active
conversations must be stopped before exporting, so each export is a coherent
snapshot.

Deletion first marks the selected tree as unavailable, drains registered participants and closes its writers. Sessions commits catalog removal together with a deletion journal, releases scoped configurations and instances, then removes the log files and owned attachment directories. Restart finishes any remaining journaled deletions. Deleting a workspace
cascades through its conversations while retaining the user's project files.
There is no archive state.

Plugin records use a typed payload (`PluginRecord<Data>` / `SessionRecords<Data>`) in the same record log with an explicit owner (plugin ID and instance ID), data, and optional display metadata. The storage reader converts old custom record envelopes after validating their original checksums, retaining IDs, parents and payloads. An unscoped historical plugin record belongs to the application instance. Unmapped historical envelopes remain available as diagnostic records in native exports. New records use explicit plugin owners or diagnostic codes. The browser receives the explicitly supplied display data and the preceding message identity on the selected branch. Model context omits these records. Deleting its owning conversation removes both the records and private data for that session’s plugin instances.

A failed run records the stable entry ID for its active input, including inbox deliveries. An explicit retry can retrieve that input from the native log. A null ID indicates the run failed before accepting the current submission. Older records with ambiguous input or missing attachment content require user input before resubmission.

File Preview reads stored attachment bytes through the conversation attachment endpoint. Workspace references remain part of the original user text and resolve through File Access when opened.

Retained independent work adds operational `task` records to the same log. The task ID is independent of record identity. State transitions do not move the conversation branch. Terminal records can include a compact result projection and bounded output with absolute byte cursors; ordinary inline tool results remain in the existing tool execution/acceptance records. A run uses its Task ID as the Run ID rather than duplicating lifecycle records. On recovery, an unfinished task is marked `interrupted` and never automatically executed again.
