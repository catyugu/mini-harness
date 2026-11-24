# @mini-harness/plugins

Discovers and mounts plugins and publishes the committed server and browser graph.

## Responsibilities

Owns catalog discovery, installed plugin files, scoped graph planning, diagnostics, browser asset publication and the plugin settings UI.

## Structure

`src/server/` owns discovery, scope planning, assets, invocation and graph coordination. `src/shared/metadata.ts` defines catalog rows. `src/browser/` renders the plugin manager.

## API

`PluginHost` is used by the composition root. `harnessPluginCatalog` exposes metadata, diagnostics and browser bootstrap. External callers use the plugin SDK.

## Dependencies

[Kernel](../kernel/README.md) manages Cordis fibers. [Settings](../settings/README.md) commits configuration. The browser runtime consumes the published graph.

## Lifecycle

Publishes the graph after a successful commit. Scoped providers mount where selected. Server cleanup drains plugin-owned work. Browser resource URLs follow the published graph.

## Configuration

`settings.json` selects plugins and providers by scope. Installed plugins declare dependencies, schema and browser assets in `plugin.json`.

Scoped requests target a mounted plugin address and use its invocation lease. Discovery checks npm peer ranges, and mounted plugins may export a synchronous semantic validator.

## Testing

[Plugin integration tests](../../test/plugins/) cover installation, precedence, runtime failures and cleanup.
