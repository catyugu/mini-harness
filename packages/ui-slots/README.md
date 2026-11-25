# @mini-harness/ui-slots

Registers browser slot owners and their contributions.

## Responsibilities

Owns ordered and keyed mounting, replacement, restoration and renderer disposal.

## Structure

`src/browser/api.ts` defines typed slots. `registry.ts` implements mounting, and `setup.ts` registers the browser service.

## API

`miniSlots` and `SlotMap` are available through the browser SDK.

## Dependencies

Uses [UI Runtime](../ui-runtime/README.md) to associate contributions with their originating browser plugins.

## Lifecycle

`core:slots` owns its browser registry. Each mounted renderer receives a disposal signal.

Keyed registrations use `order` for display and `priority` for selection (lower wins, equal priorities conflict). Each selected renderer gets a fresh signal and releases it when replaced or removed.

## Testing

`tests/registry.test.ts` covers order, replacement, disposal and staged failures.
