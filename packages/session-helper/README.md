# @mini-harness/session-helper

Adds user-facing actions for editing an earlier message and resubmitting a branch.

## Responsibilities

Owns the edit and resend interaction. Conversation handles revisions, Agent validates the target and Runs schedules the replacement.

## Structure

`src/browser/setup.ts` registers copy and edit actions and builds revision drafts.

## API

Consumes the Conversation composer and message extension points.

## Dependencies

Uses [Conversation](../conversation/README.md) to operate on stable entry IDs.

## Lifecycle

The `session-helper` application plugin owns its message actions and draft cleanup.

## Configuration

Toggle Session Helper in Plugins.

## Testing

`tests/revision.test.ts` covers parent selection, original attachments and stale revisions.
