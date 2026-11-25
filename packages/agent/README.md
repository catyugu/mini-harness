# Agent

`harnessAgent.run(ctx, input)` executes model turns, streams text and hands tool calls to a Tool Executor. Pass a model request and tool definitions for an in-memory transcript. A conversation can supply a fresh request at each turn, consume events and persist results through Sessions.

`harnessToolExecutor` presents tool definitions to the model, interprets its response and executes calls using the strategy selected by the caller. The default executor validates native arguments, runs compatible calls in parallel and delivers a message for each result. Replacements may run their own implementation and deliver results directly. The Agent checks tool call and result identities before the next model request.

`harnessPrompt` composes named sections. The nearest scope wins first, followed by higher priority within that scope. The Cordis caller determines the scope. The caller supplies any fields required by the registered sections.

`harnessCompaction` summarizes a prefix of the supplied messages and returns the index of the first message to retain. Runs maps this index to the durable conversation history.

`core:agent` sets `maxTurns`. `core:runs` controls automatic compaction.
