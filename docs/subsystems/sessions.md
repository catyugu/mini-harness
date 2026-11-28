# Sessions and workspaces

[Workspaces](../../packages/workspaces/README.md) owns canonical workspace roots and their identities. [Sessions](../../packages/sessions/README.md) owns persistent conversation identities, ancestry, permissions and the native log. A session may be unbound to a workspace. Child sessions have normal conversation identities; they are not in-memory agent objects owned by the parent run.

## Durable and live state

The native log has a single append sequence and a selected conversation branch. Runs prepares inputs for the Agent execution loop and commits outputs through the session record contract. Agent receives a caller-owned context and emits native execution events. Sessions owns the durable record contract; Runs owns volatile record state and replay. The model transcript, visible history, and operational run/inbox projections are derived from those records. Runs and Background define and recover their own session-scoped records. Tasks owns live scheduling. The [native session log reference](../session-log.md) owns framing, branch, delivery, recovery and export semantics.

[Sessions](../../packages/sessions/README.md#responsibilities-and-contracts) assigns the initial title when it commits the first user input. The optional [AI Conversation Titles](../../packages/conversation-title/README.md) plugin may refine it asynchronously after acceptance.

## Lifecycle across domains

New work resolves session/workspace identity and configured scopes before using services. Editing a persisted user message checks its branch identity and selects a new branch. Queued messages have stable delivery IDs. A browser may reconnect to live run replay without creating new work.

Session deletion marks affected resources unavailable and drains work, then commits catalog removal with a deletion journal before removing configured scopes and log/attachment files. Recovery finishes journaled cleanup. Workspace removal cascades through its sessions but does not delete project directories. There is no archive operation. See the owning packages for lifecycle contracts.

User-facing actions are contributed by [Conversation](../../packages/conversation/README.md) and [Session Helper](../../packages/session-helper/README.md).
