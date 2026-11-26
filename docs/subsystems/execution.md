# Execution

Runs writes every accepted input to the Session Log Inbox. It starts an exclusive Task for the conversation, projects Agent events into task progress and exposes replay to clients. The Task ID is the Run ID. Browser observation has its own lifetime.

Agent executes a model turn and delegates tool calls to Tools. It emits native execution events and does not own conversation context or display records. Runs supplies the current context through `prepare` and commits results through Sessions. Run-local record contributors observe Agent events, select durable presentations and publish live records through Runs; the Agent plugin owns its reasoning contribution. Tools validates arguments and invokes the owning Cordis Fiber. Ordinary tool calls use Promises and honor the Run signal. Tools closes each model tool call with a result, including skipped or interrupted calls. History records actual completed results and unknown effects are left unretried.

Independent work uses a Task with a Session owner and a stable provider. Background tools and child sessions send status through the same Inbox. Tool logs and progress remain available as task observations. Child agent transcripts belong to the child Session, not the task output buffer. A serial tool can wait for an independent Task while yielding pool capacity. Its exclusive conversation lane stays occupied.

Interrupt durably accepts input, requests cancellation of the current Run and starts its replacement after settlement. Stop pauses automatic admission before cancellation. Queue waits for the current Run to end, and Steer uses model and tool boundaries. See [Runs](../../packages/runs/README.md) for the API and delivery modes.

On restart, [Sessions](sessions.md) marks unfinished tasks interrupted. Pending Inbox messages can start fresh Runs and task outcomes generate idempotent notifications. Conversation deletion drains resources for the whole requested subtree before removing its logs.
