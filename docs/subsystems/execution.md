# Execution

Runs writes every accepted input to the Session Log Inbox. It starts an exclusive Task for the conversation, projects Agent events into live Run replay and exposes replay to clients. The Task ID is the Run ID. Browser observation has its own lifetime.

Agent executes a model turn and delegates tool calls to Tools. It emits native execution events and does not own conversation context or display records. Runs supplies the current context through `prepare` and commits results through Sessions. Run-local record contributors observe Agent events, select durable presentations and publish live records through Runs; the Agent plugin owns its reasoning contribution. Tools validates arguments and invokes the owning Cordis Fiber. Ordinary tool calls use Promises and honor the Run signal. Tools closes each model tool call with a result, including skipped or interrupted calls. History records actual completed results and unknown effects are left unretried.

[Background](../../packages/background/README.md) submits eligible tools to Tasks under the tool provider's Fiber and owns their output and history. [Subagents](../../packages/subagents/README.md) starts child conversations through Runs. Each plugin resolves its own management targets and can wait through the enclosing execution's capacity-releasing wait boundary. The exclusive conversation lane stays occupied.

Interrupt durably accepts input, requests cancellation of the current Run and starts its replacement after settlement. Stop pauses automatic admission before cancellation. Queue waits for the current Run to end, and Steer uses model and tool boundaries. See [Runs](../../packages/runs/README.md) for the API and delivery modes.

On restart, Runs and Background mark their unfinished executions interrupted. Pending Inbox messages can start fresh Runs. Both reporting plugins use stable Inbox IDs to deduplicate completion delivery. Conversation deletion drains resources for the whole requested subtree before removing its logs.
