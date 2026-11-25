# Agent

`harnessAgent.run(ctx, input)` executes model turns, streams text and hands tool calls to a Tool Executor. The input supplies each model request and can receive assistant messages and completed tool results. With no conversation services loaded, the loop maintains an in-memory transcript. Runs supplies the projected transcript and persists events for conversations.

`harnessToolExecutor` presents tool definitions to the model, interprets its response and executes calls using the strategy selected by the caller. The default executor validates native arguments, runs compatible calls in parallel and delivers a message for each result. Replacements may run their own implementation and deliver results directly. The Agent checks tool call and result identities before the next model request.

`harnessPrompt` composes named sections. The nearest scope wins first, followed by higher priority within that scope. The caller supplies the scope and any context the registered sections need.

`harnessCompaction` summarizes a prefix of the supplied messages and returns the index of the first message to retain. Runs maps this index to the durable conversation history.

`core:agent` sets `maxTurns`. `core:runs` controls automatic compaction.
