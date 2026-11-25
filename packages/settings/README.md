# @mini-harness/settings

Provides the settings dialog and HTTP routes for the active Profile.

## Responsibilities

Reads the committed Profile and forwards edits to its configuration owner.

## Structure

`src/server/` contains the settings routes. `src/browser/` owns the settings panel and contributions.

## API

`miniSettingsRegistry.register` contributes settings pages through the browser SDK.

## Dependencies

The server routes use the `harnessProfileConfig` service.

## Lifecycle

`core:settings` registers application routes. Browser controls release subscriptions when removed.

## Configuration

The active YAML Profile owns plugin configuration and scoped composition. The settings API operates on Entry IDs, with each Entry holding its `disabled` and `live` flags and `config` object together. The Profile also owns scoped Entry composition. Browser services are composed directly through Cordis.

Plugin detail content can be contributed through the settings registry and is tied to the lifetime of the displayed detail.

## Testing

`tests/config.test.ts` covers validation. [Lifecycle tests](../../test/plugins/lifecycle.test.ts) cover rollback and live config.
