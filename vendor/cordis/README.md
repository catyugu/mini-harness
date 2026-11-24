# Cordis

Shared framework source for the Node.js and browser runtimes. The root npm
package exports this source's build as `mini-harness/cordis`.

## Origin

The framework is derived from DeepSeek Harness commit
[4b399c39a6d1479cd84ca591b4d7c88e24d38a96](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/vendor).
DSH based its core on Cordis 4.0.0-rc.12 and its Loader on 1.0.0-rc.9,
both from Cordis commit `01b396240ce47cf2779c40af9bc445bb748fe112`.

## Local changes

- Retain the DSH asynchronous lifecycle and effect cleanup, raw and effective
  configuration, context tracing, service isolation, and typed events.
- Bind an abort signal and tracked asynchronous calls to each fiber activation.
- Use a small in-memory Entry Tree with module resolution supplied by each
  host. The application owns persistent settings and configuration transactions.
- Exclude YAML expressions, HMR, module interop hooks, and volatile schemas.
- Type-check with the application's strict settings and include only the
  Cosmokit utilities the runtime uses.

When syncing, review upstream lifecycle changes alongside their tests, keep
the two runtime targets on the same source, and update the origin above.
