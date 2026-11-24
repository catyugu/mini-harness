# @mini-harness/plugin-api

Defines the server plugin descriptor and capability API.

## Responsibilities

Owns descriptor fields, namespaced configuration shape and plugin selection validation.

## Structure

`src/descriptor.ts` defines setup and plugin API contracts. `configuration.ts` defines stored selections. `selection.ts` validates identifiers and provider choices.

## API

`PluginApi`, `PluginDescriptor` and `ConfigValidationContext` are published through the server SDK.

## Dependencies

Uses [Kernel](../kernel/README.md) for scopes and services and [Transport](../transport/README.md) for route types. Plugins supplies the runtime implementation.

## Testing

[Plugin lifecycle tests](../../test/plugins/lifecycle.test.ts) and `pnpm run pack:verify` exercise the contracts.
