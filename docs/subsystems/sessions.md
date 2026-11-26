# Sessions and workspaces

[Workspaces](../../packages/workspaces/README.md) owns canonical workspace roots and their identities. [Sessions](../../packages/sessions/README.md) owns persistent conversation identities, ancestry, permissions and the native log. A session may be unbound to a workspace. Child sessions have normal conversation identities; they are not in-memory agent objects owned by the parent run.

## Durable and live state

The native log has a single append sequence and a selected conversation branch. Agent and Runs prepare model inputs and deliver outputs through the session record contract. The model transcript, visible history, and operational run/inbox projections are derived from those records. The scheduler owns live task state; the persisted task projection supports historical queries, not resumed execution. The [native session log reference](../session-log.md) owns framing, branch, delivery, recovery and export semantics.

## Lifecycle across domains

New work resolves session/workspace identity and configured scopes before using services. Editing a persisted user message checks its branch identity and selects a new branch. Queued messages have stable delivery IDs. A browser may reconnect to live run replay without creating new work.

Session deletion marks affected resources unavailable, drains work, removes configured scopes, commits catalog removal and deletes log/attachment files. Workspace removal cascades through its sessions but does not delete project directories. There is no archive operation. See the owning packages for lifecycle contracts.

User-facing actions are contributed by [Conversation](../../packages/conversation/README.md) and [Session Helper](../../packages/session-helper/README.md).
