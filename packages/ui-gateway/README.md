# UI Gateway

Exposes the server endpoints used to start and synchronize the browser. It adapts the plugin catalog and projection-change service to HTTP; it does not own either the browser graph or feature state.

## Activation and endpoints

The [web Profile](../../profiles/web.yml) enables `@mini-harness/web-gateway` as `core:ui`. The [manifest](src/manifest.ts) requires `harnessPluginCatalog`, `harnessRoutes` and `harnessChanges`. It has no configuration or public SDK import.

| Endpoint             | Response                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/bootstrap` | The currently published browser Entries from `harnessPluginCatalog.browser()`, in the shared [bootstrap format](../ui-runtime/src/shared/bootstrap.ts). |
| `GET /api/changes`   | A newline-delimited JSON stream, beginning with the current revision snapshot and followed by projection change notices.                                |

The internal `harnessGateway.bootstrap()` service produces the same bootstrap object. The native [UI Runtime](../ui-runtime/README.md) is the consumer of these endpoints; extension code normally uses its request and projection helpers instead of managing a second browser bootstrap.

## Ownership and lifecycle

[`setup.ts`](src/setup.ts) registers both routes in the gateway's Cordis lifetime. It subscribes each change stream to Transport and detaches the listener when its response closes. Transport owns response framing, heartbeat and slow-client handling. Plugins owns browser Entry publication and assets; each feature owns its projection payload and refresh route.

The surrounding Host web composition authenticates requests. Gateway does not introduce a separate token, authorization policy or revision store. Removing the gateway removes its routes and closes their active work through the Transport disposer contract; application shutdown seals routing and ends streams.

## Verification

[Browser graph tests](../../test/system/browser-graph.test.ts) exercise bootstrap and browser-safe module publication. [Browser projection tests](../ui-runtime/tests/projections.test.ts) cover the receiving side, and [navigation/shutdown tests](../../test/system/navigation-shutdown.test.ts) cover shutdown behavior.

See [Transport](../transport/README.md), [Plugins](../plugins/README.md) and the [transport subsystem](../../docs/subsystems/transport.md).
