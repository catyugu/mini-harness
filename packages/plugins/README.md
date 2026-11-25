# @mini-harness/plugins

Discovers plugins and publishes configured Cordis entries and browser assets.

## Responsibilities

Owns catalog discovery, scoped entry composition, diagnostics, browser asset publication and the plugin settings UI.

## Structure

`src/server/` owns discovery, configuration transactions, and asset publication. `src/shared/metadata.ts` defines catalog rows. `src/browser/` renders the plugin manager.

## API

`PluginHost` is used by the composition root. `harnessPluginCatalog` exposes metadata, diagnostics and browser bootstrap. External callers use the plugin SDK.

## Dependencies

[Cordis](../../vendor/cordis/README.md) owns entries and fibers. [Settings](../settings/README.md) commits configuration. The browser runtime consumes the published bootstrap entries.

## Lifecycle

Enabled entries are mounted by Cordis. Child Contexts isolate the services declared by local entries; changed scoped entries are prepared before configuration commits. Host infrastructure and tool authorization boundaries retain explicit protection. Server cleanup stops admission and drains plugin-owned HTTP, scoped and upgrade handlers before disposing their instances. Browser resource URLs follow the published bootstrap entries.

## Configuration

The active YAML Profile enables entries by scope. Installed plugins declare dependency injection in their Cordis entry. Native Cordis `Config` defines validation and defaults; `plugin.json` optionally describes presentation and browser build output. Plugin detail pages display settings contributions.

Scoped requests target a mounted plugin address and use its invocation lease. Discovery checks npm peer ranges, and mounted plugins may export a synchronous semantic validator.

## Testing

[Plugin integration tests](../../test/plugins/) cover installation, precedence, runtime failures and cleanup.
