# UI Runtime

Starts the browser's Cordis graph and connects it to the server. It owns browser authentication setup, graph reconciliation, stylesheet lifetime, authenticated request helpers and delivery of projection invalidations. Feature plugins own their snapshots and views; Plugins owns the graph published by the server.

## Public browser SDK

| Import                                                                      | Purpose                                                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`mini-harness/ui-runtime/http`](src/browser/http.ts)                       | `browserRequest` for authenticated JSON requests, plus lower-level response, payload and event-stream helpers. |
| [`mini-harness/ui-runtime/plugin-settings`](src/browser/plugin-settings.ts) | `browserPluginId` and `browserPluginSettings` for the active Entry and its accepted configuration.             |
| [`mini-harness/ui-runtime/projections`](src/browser/projection-api.ts)      | `miniProjections.register(domain, projection)` and the `BrowserProjection` contract.                           |

`browserRequest(ctx, path, options)` prefixes the path with `/api`, adds the browser credential, parses JSON and combines an optional caller signal with the plugin fiber's signal. Pass `/sessions`, for example, rather than `/api/sessions`. A 401 produces `AuthenticationError`; other unsuccessful responses use the server's error message where available. Use the lower-level `api` helper for responses such as streams that are not a single JSON value, and pass its cancellation signal explicitly.

`browserPluginSettings(ctx)` reads and writes the Entry configuration through the Profile configuration owner, then reconciles the browser graph. Browser activation failures are surfaced to the write caller. The [Task notes browser module](../../docs/examples/task-notes/web.ts) demonstrates this public helper with Settings.

For a feature-owned projection, inject `miniProjections` and retain the registration disposer in a Cordis effect. Its `sync(revision, reconnect, resourceId?)` callback refreshes the feature's own data. A reconnect snapshot reaches every registered domain, including domains missing from the snapshot; a change notice reaches only its domain. Invalidations are hints to fetch authoritative state, not payload storage or a durable event log.

## Startup and lifecycle

[`boot.ts`](src/browser/boot.ts) accepts the launch token from the URL fragment, stores it in this tab's session storage and removes the fragment. It reads `/api/bootstrap`, reconciles browser Entries, then observes `/api/changes`. A new credential in a later URL fragment triggers reload. An expired credential stops the retry loop and asks for the current launch URL.

[`modules.ts`](src/browser/modules.ts) uses the native Cordis `EntryTree`; dependencies are declared by browser plugins. Entry styles must load before activation. Removing an Entry disposes its fiber and stylesheet effects. Browser plugins remain responsible for attaching requests, listeners and contributions to their own lifetimes.

Transient change-feed disconnections retry with a fresh revision snapshot. Projection failures are isolated: one owner's failed synchronization does not prevent other owners from refreshing. Feature stores decide how to combine full and resource-specific refreshes; the internal [`RemoteStore`](src/browser/remote-store.ts) is used by built-in features and is not a separate SDK export.

The runtime has no Profile Entry or configuration of its own: Host serves its startup assets and UI Gateway supplies the bootstrap and change feed. Scope-specific feature routes use the same authenticated request contract.

## Verification

[Browser graph tests](../../test/system/browser-graph.test.ts) verify published runtime dependencies and exclusion of server code. [Projection tests](../../test/system/browser-projections.test.ts) verify domain routing, failed refresh isolation and disposal. [Plugin browser tests](../../test/browser/plugins.spec.ts) exercise live graph changes and cleanup.

See [UI Gateway](../ui-gateway/README.md), [Transport](../transport/README.md), [Plugins](../plugins/README.md), and [browser composition](../../docs/subsystems/frontend.md).
