# @mini-harness/runs

Schedules and owns active runs and their replay streams.

## Responsibilities

Owns run IDs, cancellation, compaction scheduling, current activity and bounded event replay. Sessions owns durable run state.

## Structure

`src/runs.ts` coordinates execution. `events.ts` retains live history. `routes.ts` adapts run commands and `stream.ts` defines the event union.

## API

`harnessRuns` is the internal scheduler. `executionExtensions.control` provides scoped submission, status and instance-owned cancellation to native and installed plugins. Runs reads the model preference at admission and passes committed user selections to the model preference owner; Conversation consumes replay and activity.

## Dependencies

Resolves scoped [Agent](../agent/README.md) services and records run transitions through [Sessions](../sessions/README.md).

## Lifecycle

`core:runs` mounts at application scope. Subscribers may disconnect without cancelling work. Shutdown aborts and drains active runs.

## Testing

`tests/runs.test.ts` covers reconnect, durable run recovery, subtree cancellation and append failures.
