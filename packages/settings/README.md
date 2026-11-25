# @mini-harness/settings

Owns stored application configuration and the settings dialog.

## Responsibilities

Validates settings, serializes mutations, commits atomic writes and publishes revisions. The plugin host plans and applies the graph derived from each candidate.

## Structure

`src/server/` contains parsing, transactions and routes. `src/shared/` contains the settings record. `src/browser/` owns the settings panel and contributions.

## API

`harnessSettingsStore` exposes committed settings and transactions. `miniSettingsRegistry.register` is available through the browser SDK.

## Dependencies

Uses [Plugin API](../plugin-api/README.md) for selection contracts and [Platform](../platform/README.md) for atomic persistence.

## Lifecycle

`core:settings` registers application routes. Updates, plugin removal and scope deletion share one queue. Browser controls release subscriptions when removed.

## Configuration

The active YAML Profile owns plugin configuration, provider selections and scoped composition. `settings.json` stores domain policy, including tool grants and restrictions.

`readOnlyTools` holds user grants indexed by plugin ID. Browser services are composed directly through Cordis.

Plugin detail content can be contributed through the settings registry and is tied to the lifetime of the displayed detail.

## Testing

`tests/config.test.ts` covers validation. [Lifecycle tests](../../test/plugins/lifecycle.test.ts) cover rollback and live config.
