# @mini-harness/approvals

Tracks pending user approvals and publishes their state to the browser.

## Responsibilities

Owns approval creation, resolution, cancellation and conversation-level approval. Shell owns command execution.

## Structure

`src/server/` holds the approval registry and service. `src/shared/request.ts` defines the browser-facing record. `src/browser/` subscribes to approval changes.

## API

`approvalExtensions.access` opens scoped, plugin-owned approval requests. The private `harnessApprovals` service resolves decisions. `miniApprovals` exposes the live request list in the browser.

## Dependencies

Uses [Transport](../transport/README.md) to publish changes. Shell consumes approval decisions and Conversation displays pending requests.

## Lifecycle

`core:approvals` mounts at application scope. Run cancellation, session deletion and plugin disposal release pending requests and listeners. Full access only releases requests that explicitly opt in.

## Testing

[Shell approval tests](../shell/tests/approval-api.test.ts) exercise command approval and cancellation.
