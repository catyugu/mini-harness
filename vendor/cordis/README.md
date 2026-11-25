# Cordis

Node.js and the browser use the same Cordis implementation. The private
workspace packages are built into the single `mini-harness` npm package.

| Workspace package | Source | Responsibility |
| --- | --- | --- |
| `@mini-harness/cosmokit` | [cosmokit](../cosmokit/) | Shared utility types and functions |
| `@mini-harness/cordis` | [cordis](./) | Context, services, injection, events and fibers |
| `@mini-harness/cordis-loader` | [cordis-loader](../cordis-loader/) | Entry identity, reconciliation and scope groups |
| `@mini-harness/cordis-runtime` | [cordis-runtime](../cordis-runtime/) | The public `mini-harness/cordis` export |

The Loader depends on core. Core reads the fiber's entry metadata through a
core-owned type. YAML and Profile persistence stay in the host adapter.

## Origin

The framework is derived from DeepSeek Harness commit
[4b399c39a6d1479cd84ca591b4d7c88e24d38a96](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/vendor).
DSH based its core on Cordis 4.0.0-rc.12 and its Loader on 1.0.0-rc.9,
both from Cordis commit `01b396240ce47cf2779c40af9bc445bb748fe112`.
The Cosmokit package copies the used types, `isNullable` and `defineProperty`
from DSH's vendored Cosmokit 1.8.1 `misc.ts`.

## Local changes

- Retain the DSH asynchronous lifecycle and effect cleanup, raw and effective
  configuration, context tracing, service isolation, and typed events.
- Bind an abort signal and tracked asynchronous calls to each fiber activation.
- Use a small in-memory Entry Tree with module resolution supplied by each
  host. The Profile adapter supplies parsed configuration and owns persistence.
- Treat config key order as immaterial, replace entries when injection
  requirements change, and report setup failures to the caller.
- Use one listener selection path for priority and scope filtering. Cancel
  dispatch to a listener whose owning activation or registration has ended.
- Exclude YAML expressions, HMR, module interop hooks, and volatile schemas.
- Type-check with the application's strict settings and include only the
  Cosmokit utilities the runtime uses.

When syncing, review upstream lifecycle changes alongside their tests, keep
the two runtime targets on the same source, and update the origin above.
