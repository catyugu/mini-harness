# @mini-harness/sessions

Owns durable conversation identity, history and deletion.

## Responsibilities

Maintains session ancestry and permissions, the append-only log, durable inbox and run projections, and recovery of interrupted deletions.

## Structure

`src/registry.ts` owns session access and cleanup. `log.ts`, `log-api.ts` and `projection.ts` implement the durable record. `src/shared/` contains read contracts used by other runtimes.

## API

`harnessRegistry` supports internal session operations. `harnessSessions` and `sessionExtensions.records` expose identity and namespaced plugin records through the server SDK.

## Dependencies

Uses [Workspaces](../workspaces/README.md) to own storage beneath managed workspace roots. Coordinates session scope removal with [Settings](../settings/README.md).

## Lifecycle

`core:sessions` mounts at application scope. Deletion drains affected work, journals the records and removes their scoped settings and files. Startup finishes any committed journal.

## Testing

`tests/` exercises durability, branch projection, deletion recovery and log isolation. The [log protocol](../../docs/session-log.md) documents the persistent format.
