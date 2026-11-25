# LLM

`harnessLlm` streams the harness message protocol. A Cordis plugin can register an adapter using `ctx.effect(() => ctx.harnessLlm.register(adapter))`. The adapter selects matching model choices with `accepts` and implements `stream`. The nearest scope with a matching adapter wins. Within that scope, higher priority wins and a tie reports an error. Disposing an adapter removes it from future selection, and unloading its plugin cancels its streams.

Profiles select the default Pi adapter through `@mini-harness/pi-adapter`. Other adapters can coexist with it and use the model catalog for configuration and credentials.
