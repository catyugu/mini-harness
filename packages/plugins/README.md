# @mini-harness/plugins

Resolves declared Profile entries and publishes configured Cordis entries and browser assets.

## Responsibilities

Owns catalog resolution, scoped entry composition, diagnostics, browser asset publication and the plugin settings UI.

## Structure

`src/server/` owns resolution, configuration transactions, and asset publication. `src/shared/metadata.ts` defines catalog rows. `src/browser/` renders the plugin manager.

## API

`PluginHost` is used by the composition root. `harnessPluginCatalog` exposes metadata, diagnostics and browser bootstrap. External callers use the plugin SDK.

## Dependencies

[Cordis](../../vendor/cordis/README.md) owns entries and fibers. [Settings](../settings/README.md) commits configuration. The browser runtime consumes the published bootstrap entries. Scope owners contribute scope choices through the native Cordis `scopes/list` event; model providers and other UI plugins contribute dynamic schema options through `settings/options`. The catalog does not depend on specific domain implementations.

## Lifecycle

Enabled entries are mounted by Cordis. Child contexts isolate only explicitly configured services; changed scoped entries are prepared before configuration commits. Transactions cannot replace the services they are using. Server cleanup stops admission and drains plugin-owned HTTP, scoped and upgrade handlers before disposing their instances. Browser resource URLs follow the published bootstrap entries.

## Configuration

The active YAML Profile enables entries by scope. Installed plugins declare dependency injection in their Cordis entry. Native Cordis `Config` defines validation and defaults; `plugin.json` optionally describes presentation and browser build output. Plugin detail pages display settings contributions, including tool grant controls owned by Sessions.

Scoped requests target a mounted plugin address and use its invocation lease. Resolution checks npm peer ranges, and mounted plugins may export a synchronous semantic validator.

## Testing

[Plugin integration tests](../../test/plugins/) cover installation, precedence, runtime failures and cleanup.
