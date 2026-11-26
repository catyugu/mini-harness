# @mini-harness/runs

Admits session runs and projects Task Runtime lifecycle into conversation history and bounded replay.

`harnessRuns.submit(id, input, options)` returns the original Task Handle. The Task ID is the Run ID.
Runs owns the one-active-run-per-session constraint, model selection, input preparation, inbox
delivery, compaction and replay. Task Runtime owns execution, cancellation and settlement.

`src/session-run.ts` connects the Agent Loop to SessionLog. `events.ts` maintains bounded replay
and transient presentation data; `routes.ts` adapts HTTP commands. The same scoped composition is
used by native and installed plugins.

HTTP returns the admitted run without waiting for input delivery. Disconnecting subscribers does not
cancel work. Shutdown drains tasks through Task Runtime. Failed runs identify the accepted input by
stable Session Log entry ID.
