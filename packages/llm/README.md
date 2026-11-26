# LLM

`harnessLlm` streams the harness message protocol. A Cordis plugin can register an adapter using `ctx.effect(() => ctx.harnessLlm.register(adapter))`. The adapter selects matching model choices with the synchronous `accepts` predicate and implements `stream`. `accepts` must not query the aggregate catalog (which itself selects an adapter); use the adapter's own model source or provider/model identifiers. The nearest scope with a matching adapter wins. Within that scope, higher priority wins and a tie reports an error. Disposing an adapter removes it from future selection, and unloading its plugin cancels its streams.

Profiles select the default Pi adapter through `@mini-harness/pi-adapter`. Use `harnessModels.register(source, adapter, priority)` when contributing model metadata as well as transport. Register a transport-only override directly with `harnessLlm.register` only when it implements the existing model capabilities. Equal-ranked matches are ambiguous.

## Public API and usage

Import [`mini-harness/llm`](src/api.ts). `LlmPort.select` returns a selected adapter, null for ambiguity or undefined for no match. `stream(request)` yields native text/thinking deltas, tool calls and a final done event. Adapters honor the request signal and preserve opaque provider continuation data. They do not own transcript persistence.

See [model provider cookbook](../../docs/cookbook/adding-a-model-provider.md) and [extension tests](../../test/plugins/extensions.test.ts) for replacement adapters.

## Related documentation

[Package index](../README.md) · [Execution](../../docs/subsystems/execution.md)
