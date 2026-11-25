# @mini-harness/plugin-api

Defines the product plugin descriptor, settings and scope contracts.

## Responsibilities

Validates persisted selections and supplies generic runtime scope primitives.

## Structure

`src/descriptor.ts` defines metadata. `configuration.ts` and `selection.ts` describe stored selections. `shared/plugin-configuration.ts` locates the owning Entry Fiber. `scopes.ts` provides opaque runtime identities, event targets and contribution layers. `profile.ts` owns the separate configuration-address contract.

## API

The SDK exposes opaque scope keys and configuration validation types. Registration and lifetime use Cordis directly.

## Testing

The [plugin suites](../../test/plugins/) and `pnpm run pack:verify` exercise the contracts.
