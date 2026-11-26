# Agent

`harnessAgent.run(ctx, input)` executes model turns, streams text and hands tool calls to a Tool Executor. Submit a task explicitly and pass its TaskContext, a model request and tool definitions for an in-memory transcript. A conversation can supply a fresh request at each turn, consume events and persist results through Sessions.

`harnessToolExecutor` presents tool definitions to the model, interprets its response and executes calls using the strategy selected by the caller. The Tools package supplies the default executor. Replacements may reuse `executeTools` from `mini-harness/tools/execution` or deliver their own results directly. The Agent checks tool call and result identities before the next model request.

`harnessPrompt` composes named sections. The nearest scope wins first, followed by higher priority within that scope. The Cordis caller determines the scope. The caller supplies any fields required by the registered sections.

`harnessCompaction` summarizes a prefix of the supplied messages and returns the index of the first message to retain. Runs maps this index to the durable conversation history.

`core:agent` sets `maxTurns`. `core:compaction` controls automatic compaction.

## Public API and usage

Import [`mini-harness/agent`](src/api.ts). Inside an admitted task, call `ctx.harnessAgent.run(ctx, { task, signal: task.signal, request, tools })` for an in-memory transcript. The caller supplies the model choice, system prompt and messages. The alternative `prepare(turn)` contract supplies a fresh request, executor and tool map. The result is a native assistant message. Agent does not own session storage or task admission.

[Agent events](src/events.ts) are exported through `mini-harness/agent/events`: `agent/setup` contributes run-local capabilities; `agent/prepare-input` transforms input; `agent/model-request` transforms model-visible content; `agent/model-retry` can request a retry delay before output; `agent/tool-result` transforms results after raw execution persistence. Return transformed values rather than mutating inputs. Bind registrations to the run Fiber.

## Testing

[Execution tests](tests/execution.test.ts) verify the turn loop and protocol.

## Related documentation

[Package index](../README.md) · [Execution](../../docs/subsystems/execution.md)
