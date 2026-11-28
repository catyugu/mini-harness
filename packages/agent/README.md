# Agent

Agent executes the native model-and-tool turn loop. The caller supplies a signal, model input and tool capabilities; Agent returns the final native assistant message. [Runs](../runs/README.md) adds conversation admission, persistence, model selection and replay.

## Public API and usage

[`mini-harness/agent`](src/api.ts) exposes `AgentPort`, `AgentRun`, turn and model-attempt events. The caller owns the model-visible context. Inject `harnessAgent`, `harnessLlm` and `harnessToolExecutor` to execute a single model turn without tools:

```ts
import type { Context } from 'mini-harness/cordis';
import type { LlmRequest } from 'mini-harness/llm';
import 'mini-harness/agent';

export function respond(ctx: Context, request: Omit<LlmRequest, 'signal'>, signal: AbortSignal) {
  return ctx.harnessAgent.run(ctx, {
    signal,
    prepare() {
      return { request, executor: ctx.harnessToolExecutor, tools: new Map() };
    },
  });
}
```

Await the returned Promise for the assistant message. `prepare(turn)` supplies the request, executor and tool map for each turn. The returned turn may supply a `recover(request, failure)` callback to repair its actual failed request without preparing a new turn. For multi-turn work the caller retains assistant messages from `onEvent` and tool results from `deliver`, then prepares the next request from that context. `afterTurn` can continue or restart the conversation cycle. Use Runs when the work belongs to a persisted conversation.

The executor presents tool schemas, interprets the assistant response and delivers tool results. Agent rejects duplicate call IDs, unmatched results and omitted results before another model turn. Executor implementations and reusable execution helpers belong to [Tools](../tools/README.md).

## Prompt capability

[`mini-harness/agent/prompt`](src/prompt-api.ts) declares `harnessPrompt`. Register named sections in an activation-owned effect. Selection uses the nearest scope, then the highest priority for the same section ID; equal winning priorities conflict. Selected sections render by ascending order and then ID. The caller supplies the fields required by each section, and rendering runs under the section provider's Fiber and the request signal.

## Conversation hooks

[`mini-harness/agent/events`](src/events.ts) declares the hooks used by Runs:

| Hook                    | Purpose                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `agent/setup`           | Register scoped capabilities before execution.                                                     |
| `agent/records`         | Observe native events and contribute assistant record presentations.                               |
| `agent/prepare-input`   | Transform prepared user content before acceptance.                                                 |
| `agent/model-request`   | Repeatable model-visible content projection.                                                  |
| `agent/prepare-request` | Prepare the final request once per turn.                                                      |
| `agent/recover-request` | Repair the last attempted request; the first handler to accept recovery wins. |
| `agent/model-retry`     | Choose whether to retry a failed request before output has streamed.                               |
| `agent/tool-result`     | Transform accepted tool content after raw execution is persisted.                                  |

These hooks are dispatched by conversation orchestration in Runs; a direct `harnessAgent.run` call uses its supplied callbacks. The native execution API and model request loop do not import session contracts. The conversation integration in `events.ts` owns scoped policy dispatch and record contributions. `agent/setup` receives the target Run Context. Resolve the target tool or prompt service from that Context and pass the contributing Context as the registration provider. Return the registration disposer (or an effect disposer for multiple registrations). Runs binds it to both the contributing Fiber and the Run, so either lifetime ending releases the contribution. Synchronous record observers own any per-run state they need. Return transformed values instead of mutating inputs. The [execution reference](../../docs/subsystems/execution.md) describes their position in the persistence flow.

Request recovery uses the last attempted request and the same turn's executor and tool capabilities. Preparation hooks are not rerun. Both preparation and recovery handlers can call `step.rebuild(request, messages, signal)` with the current prepared request and replacement conversation messages: this reprojects model-visible messages through `agent/model-request` and the executor, retains the current request's other parameters and invalidates its input measurement. Put repeatable, nonpersistent message contributions in `agent/model-request` (it may run multiple times); use `agent/prepare-request` for once-per-turn effects and final request parameters. Rebuild replaces the message sequence, so direct message edits in final preparation are not replayed. A handler changing measured request parameters must invalidate or update the measurement.

## Configuration, lifetime and failures

The base Profile mounts separate `core:agent`, `core:prompt` and `core:prompt-defaults` entries. [Agent configuration](src/manifests/agent.ts) bounds a run's model steps. [Context Management](../context-management/README.md) prepares and repairs persistent conversation requests.

The caller's signal owns cancellation. Agent reports phase, request, attempt metrics, assistant-start, text and thinking deltas, and assistant events through `onEvent`. The loop does not construct session or display records. The Agent plugin contributes its reasoning record through `agent/records` for conversation-bound runs. Model errors, invalid tool protocol and exhausting the turn limit reject the run. Transient retry applies before streamed output. A normalized context-limit error can invoke the caller’s recovery callback to replace the request for the same step.

## Verification

[Execution tests](../runs/tests/agent-execution.test.ts) cover alternate executors, tool identity, cancellation, retry boundaries and background receipts. See [model provider development](../../docs/cookbook/adding-a-model-provider.md) and the [package index](../../docs/packages.md).
