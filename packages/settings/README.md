# @mini-harness/settings

Owns stored application configuration and the settings dialog.

## Responsibilities

Validates settings, serializes mutations, commits atomic writes and publishes revisions. The plugin host plans and applies the graph derived from each candidate.

## Structure

`src/server/` contains parsing, transactions and routes. The Entry configuration contract belongs to Plugin API. `src/browser/` owns the settings panel and contributions.

## API

`harnessSettingsStore` exposes committed settings and transactions. `miniSettingsRegistry.register` is available through the browser SDK.

## Dependencies

Uses [Plugin API](../plugin-api/README.md) for selection contracts and [Platform](../platform/README.md) for atomic persistence.

## Lifecycle

`core:settings` registers application routes. Entry updates and scope deletion share one queue. Browser controls release subscriptions when removed.

## Configuration

The active YAML Profile owns plugin configuration and scoped composition. The settings API operates on Entry IDs, with each Entry holding its `disabled` and `live` flags and `config` object together. `settings.json` stores domain policy, including scoped tool restrictions.

Browser services are composed directly through Cordis.

Plugin detail content can be contributed through the settings registry and is tied to the lifetime of the displayed detail.

## Testing

`tests/config.test.ts` covers validation. [Lifecycle tests](../../test/plugins/lifecycle.test.ts) cover rollback and live config.
