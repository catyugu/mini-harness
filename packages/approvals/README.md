# Approvals

Approvals owns pending user confirmations and their resolution. It binds requests to a conversation, the requesting plugin's lifetime and the supplied execution signal. The operation itself remains owned by the caller, such as [Shell](../shell/README.md).

## Public API and usage

Import [`mini-harness/approvals`](src/server/api.ts), inject `harnessApprovalRequests`, and request confirmation before performing the operation:

```ts
// Inside an injected plugin, with an existing session and operation signal:
await ctx.harnessApprovalRequests.request(
  sessionId,
  { title: 'Save note', message: 'Write this note to the workspace?' },
  signal,
);
// Perform the operation after the promise resolves.
```

Resolution means approval. The boolean is `false` for an explicit Allow and `true` when an explicit Full access selection released a request with `followFullAccess: true`; it is not an allow/deny flag. Denial rejects with `ApprovalDenied`. Cancellation and expiration reject rather than approve.

The optional prompt `context` and explicit execution ID identify an operation for repeated-denial handling within one Run. `followFullAccess` defaults to false: callers explicitly choose whether a later Full access selection may release their pending request. Calling the API does not itself skip confirmation merely because a conversation already has Full access.

## Ownership and lifetime

The service derives plugin identity from the caller's Entry/Fiber and validates the session. A pending request follows the supplied signal and caller Fiber. Session deletion and approvals disposal release outstanding requests. Run settlement clears repeated-denial memory for its explicit execution ID.

Pending requests expire after five minutes. An identical denied operation with the same session, plugin, context and message is rejected within that run without opening another prompt. That denial memory ends with the run.

`harnessApprovals` is the decision/projection service: it exposes pending records, decides a request by ID and releases opted-in requests for a session's Full access selection. Operation plugins should use `harnessApprovalRequests`; the shared approval UI uses the decision surface.

## Composition and UI

The base Profile's `core:approvals` entry requires Sessions, Runs and change notifications. HTTP routes are installed when Transport routing is present. The Web Profile's `core:approval-data` entry owns the browser `miniApprovals` projection, and [Conversation](../conversation/README.md) renders the shared approval panel.

There is no approval configuration schema or durable request queue. Restart does not recreate pending confirmations. Approval is an operation decision; filesystem isolation and tool policy remain separate contracts.

## Verification

[Shell approval tests](../shell/tests/approval-api.test.ts) cover explicit decisions, Full access, repeated denials and cancellation. [Task notes](../../docs/examples/task-notes/plugin.ts) demonstrates an installed plugin using the same interface. See [transport](../../docs/subsystems/transport.md) and the [package index](../../docs/packages.md).
