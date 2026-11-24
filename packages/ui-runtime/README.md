# @mini-harness/ui-runtime

Bootstraps the browser and runs its Cordis plugin graph.

## Responsibilities

Owns startup assets, authentication, dependency-ordered setup, stylesheet and preload lifetimes, remote requests and projection synchronization.

## Structure

`src/assets/` contains the startup document, icons and startup stylesheet. `src/browser/` contains the browser host and protocol client. `src/shared/` contains the browser graph contract. The change-feed payload is owned by Transport.

## API

`FrontendSetup`, `FrontendApi` and projection and contribution types are published through the browser SDK.

## Dependencies

Consumes the graph supplied by [UI Gateway](../ui-gateway/README.md) and packages the browser Cordis runtime.

## Lifecycle

Refreshes graph and projections after reconnects. Disposes owned styles, JS preloads, contributions and requests when a plugin unloads.

## Testing

[Browser graph and projection tests](../../test/system/) and [plugin browser tests](../../test/browser/plugins.spec.ts) cover composition, reload and cleanup.
