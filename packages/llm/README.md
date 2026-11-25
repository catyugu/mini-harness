# LLM

`harnessLlm` streams the harness message protocol. A Cordis plugin can register an adapter using `ctx.effect(() => ctx.harnessLlm.register(adapter))`. The adapter selects matching model choices with the synchronous `accepts` predicate and implements `stream`. `accepts` must not query the aggregate catalog (which itself selects an adapter); use the adapter's own model source or provider/model identifiers. The nearest scope with a matching adapter wins. Within that scope, higher priority wins and a tie reports an error. Disposing an adapter removes it from future selection, and unloading its plugin cancels its streams.

Profiles select the default Pi adapter through `@mini-harness/pi-adapter`. Use `harnessModels.register(source, adapter, priority)` when contributing model metadata as well as transport. Register a transport-only override directly with `harnessLlm.register` only when it implements the existing model capabilities. Equal-ranked matches are ambiguous.
