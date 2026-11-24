# @mini-harness/settings

Owns stored application configuration and the settings dialog.

## Responsibilities

Validates settings, serializes mutations, commits atomic writes and publishes revisions. The plugin host plans and applies the graph derived from each candidate.

## Structure

`src/server/` contains parsing, transactions and routes. `src/shared/` contains the settings record. `src/browser/` owns the settings panel and contributions.

## API

`harnessSettingsStore` exposes committed settings and transactions. `settingsExtensions.register` is available through the browser SDK.

## Dependencies

Uses [Plugin API](../plugin-api/README.md) for selection contracts and [Platform](../platform/README.md) for atomic persistence.

## Lifecycle

`core:settings` registers application routes. Updates, plugin removal and scope deletion share one queue. Browser controls release subscriptions when removed.

## Configuration

`settings.json` stores the port, plugin flags and namespaced config, provider selections and scopes. Defaults come from the parser and each plugin manifest.

## Testing

`tests/config.test.ts` covers validation. [Lifecycle tests](../../test/plugins/lifecycle.test.ts) cover rollback and live config.
