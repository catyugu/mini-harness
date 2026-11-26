# @mini-harness/runs

Admits session runs and projects Task Runtime lifecycle into bounded replay. Sessions persists the
same Task snapshot plus conversation-specific run details; the runtime owns the lifecycle.

`harnessRuns.submit(id, input, options)` is the only ordinary run submission API. It returns the original Task Handle; the Task ID is the Run ID. `current(id)` returns the current run or compaction handle. Await, inspect and cancel through that handle, rather than a separate run lifecycle API.
Runs selects an exclusive conversation lane for both runs and compaction. Task Runtime owns its
admission, execution, cancellation and settlement. Runs owns model selection, input preparation,
inbox delivery, compaction and replay.

`src/session-run.ts` connects the Agent Loop to SessionLog. `events.ts` maintains bounded replay
and transient presentation data; `routes.ts` adapts HTTP commands. The same scoped composition is
used by native and installed plugins.

HTTP returns the admitted run without waiting for input delivery. Disconnecting subscribers does not
cancel work. Shutdown drains tasks through Task Runtime. Failed runs identify the accepted input by
stable Session Log entry ID.
