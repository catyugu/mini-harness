# Plugin API

Plugin API defines the small contracts shared by plugin composition and capability providers. It owns configuration shapes, opaque runtime scopes, plugin-private service interfaces and observations. [Cordis](../../docs/cordis.md) owns service injection, events and activation lifetime; [Plugins](../plugins/README.md) implements the Profile-backed services.

## Public SDK

External plugins import the following root-package exports. The workspace package name is not an installed SDK entry.

| Import                              | Contract                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `mini-harness/configuration`        | [Native configuration validation](src/configuration.ts), persistent `ScopeAddress` and `ProfileScopes` bindings.                     |
| `mini-harness/scopes`               | [Opaque scope identities](src/scopes.ts), ancestry, contribution ranking and event targeting.                                        |
| `mini-harness/plugin-data`          | [PluginData, PluginSecrets and service declarations](src/services.ts), including `harnessPluginSettings` and `harnessPluginChanges`. |
| `mini-harness/plugin-configuration` | [PluginConfiguration](src/shared/plugin-configuration.ts) and Entry-owned configuration handles.                                     |
| `mini-harness/observations`         | [Capability observations](src/observations.ts), `observe` and the `harness/observe` event.                                           |

Use `defineConfig` as a plugin's native Cordis `Config` export. It clones the candidate, applies JSON Schema defaults, validates synchronously, then runs an optional semantic refinement. Its `jsonSchema` describes the validation contract; browser configuration views are authored separately by each plugin. The [settings cookbook](../../docs/cookbook/adding-a-settings-page.md) and [greeting example](../../docs/examples/greeting-service/plugin.ts) show complete declarations.

## Scope contracts

A `ScopeKey` is an opaque object compared by identity. `createScopeKey` creates it; `setScopeParent` changes its ancestry and rejects cycles. `tagScope` attaches an existing key to a Context whose lifetime is already owned by Cordis. Scope routing does not grant filesystem or process access.

`rankScoped` selects visible ancestry and orders it by nearest scope, then descending priority. `sameRank` lets a capability owner diagnose an ambiguous tie. `scopeTarget` includes unscoped listeners and listeners on the target's ancestry while preserving the caller's existing event filter. `ScopedLayers` enforces one named contribution per scope and returns nearest layers first; the consuming registry decides how those layers combine.

A persistent `ScopeAddress`, such as `session:<id>`, is separate from the runtime key. Domain owners register address resolvers through `harnessProfileScopes.register(owner, namespace, resolve)`. They notify `changed` when a resource's membership or parent changes. Callers `prepare` a resource's configured composition before taking its `context`; `address` exposes persistent ancestry. [Scoped providers](../../docs/scoped-providers.md) describes cross-package composition and service replacement.

## Configuration, data and observations

`PluginConfiguration` reads the owning Entry's effective configuration. `set` and `patch` go through the host's validated update transaction; a patch changes its fields together. `subscribe` reports committed value changes and is disposed with the caller. Handles are bound to both the caller and Entry lifetime, clone read values, and reject writes during plugin setup or after disposal.

Plugin data and secrets use the mounted Entry and scope as their namespace. The [Plugins README](../plugins/README.md) owns persistence and credential semantics; the interface in this package does not create a separate store. `harnessPluginChanges.invalidate()` requests publication of that plugin's changed data.

`observe` dispatches to visible `harness/observe` listeners through each listener's Fiber. It is best-effort asynchronous observation: a failing observer is logged and does not become the capability's transaction or completion result. Domain packages extend `CapabilityObservations` with their own event payloads.

## Internal composition contracts and tests

[descriptor.ts](src/descriptor.ts) holds presentation/build metadata; [selection.ts](src/selection.ts) validates the Profile envelope; [profile.ts](src/profile.ts) describes the host runtime, configuration port and launch options. These internal modules do not provide an alternative external plugin loader.

[Composition tests](../../test/plugins/composition.test.ts), [lifecycle tests](../../test/plugins/lifecycle.test.ts) and [live-settings tests](../../test/system/live-settings.test.ts) cover scope selection, configuration rollback and lifetime. [Plugin development](../../docs/plugins.md) documents module packaging; the [Task notes example](../../docs/examples/task-notes/README.md) consumes these contracts from an external package.
