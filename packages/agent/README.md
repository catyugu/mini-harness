# Agent

Agent executes the native model-and-tool turn loop. The caller supplies a signal, model input and tool capabilities; Agent returns the final native assistant message. [Runs](../runs/README.md) adds conversation admission, persistence, model selection and replay.

## Public API and usage

[`mini-harness/agent`](src/api.ts) exposes `AgentPort`, `AgentRun`, turn and model-attempt events. Inject `harnessAgent`, `harnessLlm` and `harnessToolExecutor` to execute an in-memory conversation:

```ts
import type { Context } from 'mini-harness/cordis';
import type { LlmRequest } from 'mini-harness/llm';
import 'mini-harness/agent';

export function respond(ctx: Context, request: Omit<LlmRequest, 'signal'>, signal: AbortSignal) {
  return ctx.harnessAgent.run(ctx, { signal, request, tools: [] });
}
```

Await the returned Promise for the assistant message. The fixed `request` form maintains an in-memory transcript. The alternative `prepare(turn)` form supplies a fresh request, executor and tool map for each turn; `deliver` and `afterTurn` let the caller commit results and continue or restart a conversation cycle. Use Runs when the work belongs to a persisted conversation.

The executor presents tool schemas, interprets the assistant response and delivers tool results. Agent rejects duplicate call IDs, unmatched results and omitted results before another model turn. Executor implementations and reusable execution helpers belong to [Tools](../tools/README.md).

## Prompt capability

[`mini-harness/agent/prompt`](src/prompt-api.ts) declares `harnessPrompt`. Register named sections in an activation-owned effect. Selection uses the nearest scope, then the highest priority for the same section ID; equal winning priorities conflict. Selected sections render by ascending order and then ID. The caller supplies the fields required by each section, and rendering runs under the section provider's Fiber and the request signal.

## Conversation hooks

[`mini-harness/agent/events`](src/events.ts) declares the hooks used by Runs:

| Hook                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `agent/setup`         | Contribute capabilities to the run Context before execution.         |
| `agent/prepare-input` | Transform prepared user content before acceptance.                   |
| `agent/model-request` | Transform model-visible content before a request.                    |
| `agent/model-retry`   | Choose whether to retry a failed request before output has streamed. |
| `agent/tool-result`   | Transform accepted tool content after raw execution is persisted.    |

These hooks are dispatched by conversation orchestration in Runs; a direct `harnessAgent.run` call uses its supplied callbacks. Register run-local effects on the supplied run Context so disposal releases them. Return transformed values instead of mutating inputs. The [execution reference](../../docs/subsystems/execution.md) describes their position in the persistence flow.

## Configuration, lifetime and failures

The base Profile mounts separate `core:agent`, `core:prompt` and `core:prompt-defaults` entries. [Agent configuration](src/manifests/agent.ts) bounds a run's model steps. [Context Management](../context-management/README.md) prepares and repairs persistent conversation requests.

The caller's signal owns cancellation. Agent reports phase, request, attempt metrics, assistant-start, text delta and assistant events through `onEvent`. Model errors, invalid tool protocol and exhausting the turn limit reject the run. Transient retry applies before streamed output. A normalized context-limit error can invoke the caller’s recovery hook to replace the request for the same step.

## Verification

[Execution tests](tests/execution.test.ts) cover alternate executors, tool identity, cancellation, retry boundaries, compaction and background receipts. See [model provider development](../../docs/cookbook/adding-a-model-provider.md) and the [package index](../../docs/packages.md).
