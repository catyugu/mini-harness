# LLM

LLM owns the harness message protocol and scoped adapter selection. It translates a native request into a stream through a selected provider adapter. Credentials and model discovery belong to [Models](../models/README.md); conversation persistence belongs to [Sessions](../sessions/README.md).

## Public API and usage

[`mini-harness/llm`](src/api.ts) exports requests, native user/assistant/tool messages, stream events, validation helpers and the `LlmAdapter`/`LlmPort` contracts. Shared model choices, thinking levels and tool schemas are exported by [`mini-harness/llm/vocabulary`](src/vocabulary.ts).

An adapter implements a synchronous `accepts(model)` predicate and `stream(request)`. It can supply `countInputTokens(request)` for exact system, tool and message totals, and classify failures as transient, permanent, context overflow or image limit. Report known usage with uncached input, cached reads, cached writes and output as disjoint counts. For a transport-only replacement, inject `harnessLlm` and bind its registration to the plugin's activation:

```ts
import type { Context } from 'mini-harness/cordis';
import type { LlmAdapter } from 'mini-harness/llm';

export function registerTransport(ctx: Context, adapter: LlmAdapter) {
  ctx.effect(() => ctx.harnessLlm.register(adapter));
}
```

When adding both a model and its transport, use [Models' paired registration](../models/README.md#model-contributions) instead. The [provider cookbook](../../docs/cookbook/adding-a-model-provider.md) shows that path.

## Selection and lifetime

Selection searches the caller's scope ancestry. The nearest matching scope wins, followed by the highest priority in that scope. `select` returns the adapter, `undefined` when absent, or `null` for an equal-ranked ambiguity. `stream` rejects absent and ambiguous selections.

`accepts` must be a pure predicate on the model choice. It must not re-enter aggregate model or adapter selection, which would recurse. Use provider/model identifiers or the adapter's own source.

Removing a registration prevents future selection. A stream combines its request signal with the registering provider's Fiber signal, so unloading that provider cancels its active streams. Adapters must cooperate with cancellation.

## Native protocol

A stream yields text or thinking deltas, tool calls and a final `done` event containing the complete assistant message. The final message preserves provider continuation data, text/thinking signatures and tool identities; consumers leave opaque provider fields to the adapter.

`validateNativeMessage` checks message shape. `validateRequestSnapshot` and `RequestMessages` validate a complete or incrementally built request, including unique tool-call IDs and exactly matched tool results. A partial tool exchange cannot become the next model request.

The `core:llm` entry supplies selection without installing a provider. The default Pi adapter is a separate entry owned by Models. There is no LLM configuration schema or transcript store.

## Verification

[Extension tests](../../test/plugins/extensions.test.ts) exercise replacement and scoped adapters; [adapter tests](../models/tests/adapter.test.ts) verify the default transport. See the [execution reference](../../docs/subsystems/execution.md) and [package index](../../docs/packages.md).
