# Execution

The runtime is assembled from independent services, not a second scheduler in the conversation layer.

| Capability                                    | Owns                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| [Tasks](../../packages/tasks/README.md)       | Generic scheduling, admission, live state, cancellation and settlement |
| [Runs](../../packages/runs/README.md)         | Conversation-specific admission policy, input delivery and replay      |
| [Agent](../../packages/agent/README.md)       | Model-turn protocol, prompt/compaction contracts                       |
| [LLM](../../packages/llm/README.md)           | Native model protocol and transport selection                          |
| [Tools](../../packages/tools/README.md)       | Scoped registration, argument validation and invocation                |
| [Sessions](../../packages/sessions/README.md) | Durable history and optional task history binding                      |

## A conversation run

Runs selects the exclusive session lane and submits through Task Runtime. Its Task ID is the Run ID. Runs prepares the input, selects the scoped model and tool set, and calls Agent with the TaskContext. Agent streams through LLM and delegates tool calls to its executor. The default executor selects serial or parallel jobs, and Tasks performs their scheduling. Inline tool tasks are structured children; the parent cannot settle until those children drain. The accepted tool result and model-visible transcript remain domain records, not a scheduler transcript.

Runs adapts events into bounded replay while Sessions writes the authoritative log. Browser disconnect does not own or cancel the run. A retained independent task can use a session history binding without making the scheduler depend on Sessions.

## Independent work and delegation

A caller may retain a handle rather than await it. For independent work use an explicit resource owner and a provider context whose lifetime is long enough. Tools can acknowledge a retained background invocation with one model-visible receipt; its later result is task history, not a second result for the same tool call.

[Subagents](../../packages/subagents/README.md) creates a normal child session and submits its run with a shared pool. A parent run stopping does not implicitly stop an independently owned child conversation. A serial task-control tool can wait for another task while yielding the enclosing run's pool capacity; the lane remains occupied. This is a whole-task waiting boundary, not an arbitrary concurrent tool callback. Deletion follows the resource ownership tree and drains all affected work.

## Failure and recovery

Cancellation is cooperative and admission is held until settlement. On restart, Sessions records unfinished retained work as interrupted; it does not resurrect execution. Unknown tool effects are not automatically retried. See [Sessions](sessions.md) and [the record format](../session-log.md).

See the [Tasks API](../../packages/tasks/README.md) for scheduler guarantees and the [tool cookbook](../cookbook/adding-a-tool.md) for extensions.
