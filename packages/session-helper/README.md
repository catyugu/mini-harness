# @mini-harness/session-helper

Adds user-facing actions for editing an earlier message and resubmitting a branch.

## Responsibilities

Owns the revision interaction and route adapter. Agent resolves the revision target and Runs schedules the replacement.

## Structure

`src/server/setup.ts` registers revision routes. `src/browser/setup.ts` contributes message actions.

## API

Consumes `harnessRuns` and the Conversation composer and message extension points.

## Dependencies

Uses [Runs](../runs/README.md) and [Conversation](../conversation/README.md) to operate on stable entry IDs.

## Lifecycle

The `session-helper` application plugin owns its routes, message actions and draft cleanup.

## Configuration

Toggle Session Helper in Plugins.

## Testing

`tests/revision.test.ts` covers parent selection, original attachments and stale revisions.
