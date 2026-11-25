# @mini-harness/plugin-api

Defines the product plugin descriptor, settings and scope contracts.

## Responsibilities

Validates identifiers and user selections. Associates persistent Entry ownership and namespaced scope keys with Cordis entries.

## Structure

`src/descriptor.ts` defines metadata. `configuration.ts` and `selection.ts` describe stored selections. `instance.ts` and `scopes.ts` connect product addresses to Context. `mutation-api.ts` supplies the settings transaction and request guards.

## API

The SDK exposes `pluginScope`, `sessionService` and configuration validation types. Plugin registration and lifetime use Cordis directly.

## Testing

The [plugin suites](../../test/plugins/) and `pnpm run pack:verify` exercise the contracts.
