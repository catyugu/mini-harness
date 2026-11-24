# @mini-harness/runs

Schedules and owns active runs and their replay streams.

## Responsibilities

Owns run IDs, submission-time model selection, cancellation, compaction scheduling, current activity and bounded event replay. Only accepted ordinary user inputs update the application model preference. Sessions owns durable run state.

## Structure

`src/runs.ts` coordinates execution. `events.ts` retains live history. `routes.ts` adapts run commands and `stream.ts` defines the event union.

## API

`harnessRuns` is the internal scheduler. Conversation consumes the replay and activity interfaces and transforms display data at its transport boundary.

## Dependencies

Resolves scoped [Agent](../agent/README.md) services and records run transitions through [Sessions](../sessions/README.md).

## Lifecycle

`core:runs` mounts at application scope. Subscribers may disconnect without cancelling work. Shutdown aborts and drains active runs.

## Testing

`tests/runs.test.ts` covers reconnect, durable run recovery, subtree cancellation and append failures.
