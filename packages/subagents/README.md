# @mini-harness/subagents

Schedules child agents and exposes delegated conversations.

## Responsibilities

Owns the delegate tool, depth and concurrency policy, inherited model choices and child-run scheduling.

## Structure

`src/server/delegation.ts` implements scheduling. `src/server/setup.ts` wires the delegate tool. `src/browser/setup.ts` contributes delegated links.

## API

Contributes the `delegate` tool and a Conversation tool-rendering extension.

## Dependencies

Uses [Sessions](../sessions/README.md) for ancestry and [Runs](../runs/README.md) for actual child executions.

## Lifecycle

The `subagents` application plugin releases its leases on cancellation. Waiting parents yield execution slots while descendants run.

## Configuration

The manifest defines live `maxDepth`, `maxParallel` and model defaults. The tool can select a provider and model for a child.

## Testing

`tests/` covers queue limits, recursive execution, cancellation and inherited model visibility.

Delegation uses source-bound `sessionExtensions.access` and `runExtensions.access`, the same capabilities offered to installed plugins. The semaphore lends a scheduling lease, never an agent execution callback.
