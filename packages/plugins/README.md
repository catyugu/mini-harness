# @mini-harness/plugins

Discovers plugins and publishes configured Cordis entries and browser assets.

## Responsibilities

Owns catalog discovery, installed plugin files, scoped provider selection, diagnostics, browser asset publication and the plugin settings UI.

## Structure

`src/server/` owns discovery, provider selection, configuration transactions, and asset publication. `src/shared/metadata.ts` defines catalog rows. `src/browser/` renders the plugin manager.

## API

`PluginHost` is used by the composition root. `harnessPluginCatalog` exposes metadata, diagnostics and browser bootstrap. External callers use the plugin SDK.

## Dependencies

[Cordis](../../vendor/cordis/README.md) owns entries and fibers. [Settings](../settings/README.md) commits configuration. The browser runtime consumes the published bootstrap entries.

## Lifecycle

The application selects required capabilities and fixed features independently of descriptor defaults. PluginHost verifies protected provider identity in the effective settings and publishes only after required capabilities mount. New required scoped provider selections are mounted before committing configuration. Optional scoped instances may remain lazy. Server cleanup stops admission and drains plugin-owned HTTP, scoped and upgrade handlers before disposing their instances. Browser resource URLs follow the published bootstrap entries.

## Configuration

The active YAML Profile selects plugins and providers by scope. Installed plugins declare dependency injection in their Cordis entry. `plugin.json` describes schema and browser assets. Plugin detail pages display settings contributions, including tool grant controls owned by Sessions.

Scoped requests target a mounted plugin address and use its invocation lease. Discovery checks npm peer ranges, and mounted plugins may export a synchronous semantic validator.

## Testing

[Plugin integration tests](../../test/plugins/) cover installation, precedence, runtime failures and cleanup.
