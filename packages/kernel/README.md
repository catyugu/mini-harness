# @mini-harness/kernel

Provides the Cordis composition and lifecycle mechanisms used by the application.

## Responsibilities

Owns provider resolution, scope contracts, fiber mounting and rollback, ordered contributions, observations and the mutation guard contract.

## Structure

`src/composition.ts` resolves dependency order. `mounts.ts` manages fiber transactions. `scopes.ts`, `services.ts`, `contributions.ts` and `observations.ts` define capability contracts.

## API

`ServiceMap` covers public services and accepts augmentation. `HostServices` also includes application-internal Cordis services.

## Dependencies

Builds on Cordis. Product capabilities define their own service names and contribute through the kernel contracts.

## Lifecycle

Disposes consumers before providers, aborts plugin lifetimes before draining them, and rolls back staged mounts or live configurations on failure. Cordis startup and quiescence events let capabilities own their asynchronous recovery and draining; mutation guards belong to active resource owners.

## Testing

[Plugin composition and lifecycle tests](../../test/plugins/) exercise selection, scope isolation, cleanup and rollback.
