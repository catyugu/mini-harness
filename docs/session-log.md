# Native session storage

mini-harness owns conversation history, branching, run state, queued input and
compaction. The model adapter receives a projection of this history and does not
open or write session files.

## Files and ownership

`~/.mini-harness/sessions.json` is the conversation catalog. Each record
contains `id`, `workspaceId`, `parentId`, `title`, `titleSource` and `createdAt`.
Workspace identity is stored separately in `workspaces.json`.

Each conversation has one native JSONL file under
`~/.mini-harness/sessions/<workspace-hash>/<conversation-id>.jsonl`. The Session
Registry owns the writer and resolves this path from catalog identity. It does
not accept an arbitrary path from an API request. Session directories must remain
inside managed storage; symlinked directories, symlinked files, aliased hardlinks
and files replaced while open are rejected. New directories use mode `0700` and
new log files use `0600` where supported.

The log starts with a version 1 `session` header. Every later line contains a
native event, a monotonically increasing `seq`, a stable hexadecimal `id`, a
`parentId`, an ISO timestamp and a SHA-256 checksum. Native IDs contain 32
hexadecimal characters.

A `model-request` entry captures the native input before streaming. Its parent identifies the active branch snapshot. An omitted `request.messages` means the messages are derived from that parent's model context. Transformed messages and compaction inputs are stored directly. The session ID comes from the log header. A retry uses the same captured input.

A `tool-execution` entry records a completed side effect before a model-visible result transform. These records and model requests are operational entries. They do not advance the selected branch or appear as chat messages. A failed result transform commits a safe tool error so the original content stays out of later model requests.

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
Messages, model choices, thinking settings, custom records, compactions, context
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
the original message in the conversation projection. Custom plugin records are
namespaced and follow the selected branch.

User presentation is stored separately from model input. A text attachment or
expanded skill remains available to the model, while the interface shows the
submitted text and attachment labels. Assistant reasoning signatures, tool call
signatures, usage and opaque provider continuation metadata survive round trips
through the log.

## Durable inbox

Queued steering and follow-up input receives a stable delivery ID. Enqueue is
acknowledged only after its event is durable. Delivering it appends one user
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
native JSONL string in `log`. Selecting a parent includes its descendants. Active
conversations must be stopped before exporting, so each export is a coherent
snapshot.

Deletion first marks the selected conversation tree as unavailable, waits for
registered participants to stop, releases scoped plugins and closes its writers.
It then commits catalog removal together with a deletion journal before removing
files. Restart finishes any remaining journaled deletions. Deleting a workspace
cascades through its conversations while retaining the user's project files.
There is no archive state.
