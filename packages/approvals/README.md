# @mini-harness/approvals

Tracks pending shell approvals and publishes their state to the browser.

## Responsibilities

Owns approval creation, resolution, cancellation and conversation-level approval. Shell owns command execution.

## Structure

`src/server/` holds the approval registry and service. `src/shared/request.ts` defines the browser-facing record. `src/browser/` subscribes to approval changes.

## API

`harnessApprovals` opens and resolves approval requests. `miniApprovals` exposes the live request list in the browser.

## Dependencies

Uses [Transport](../transport/README.md) to publish changes. Shell consumes approval decisions and Conversation displays pending requests.

## Lifecycle

`core:approvals` mounts at application scope. Run cancellation and plugin disposal release pending requests and listeners.

## Testing

[Shell approval tests](../shell/tests/approval-api.test.ts) exercise command approval and cancellation.
