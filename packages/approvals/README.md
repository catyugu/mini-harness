# @mini-harness/approvals

Tracks pending user confirmations and publishes their state to the browser.

## Responsibilities

Owns approval creation, resolution, cancellation and conversation-level approval. Shell owns command execution.

## Structure

`src/server/` holds the approval registry and service. `src/shared/request.ts` defines the browser-facing record. `src/browser/` subscribes to approval changes.

## API

`approvalExtensions.request` opens scoped confirmations. The internal `harnessApprovals` service supplies pending state to Conversation. `miniApprovals` exposes the live request list in the browser.

## Dependencies

Uses [Transport](../transport/README.md) to publish changes. Shell consumes approval decisions and Conversation displays pending requests.

## Lifecycle

`core:approval-data` owns the browser projection and consumes the application approval capability. `core:approvals` mounts at application scope. Run cancellation and plugin disposal release pending requests and listeners.

Native and installed plugins use `approvalExtensions.request`. Requests carry the plugin identity, session, current run and cancellation signal. Conversation owns the shared approval panel.

## Testing

[Shell approval tests](../shell/tests/approval-api.test.ts) exercise command approval and cancellation.
