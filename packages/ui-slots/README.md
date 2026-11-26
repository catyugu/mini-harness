# @mini-harness/ui-slots

Registers browser slot owners and their contributions.

## Responsibilities

Owns ordered and keyed mounting, replacement, restoration and renderer disposal.

## Implementation

`src/browser/api.ts` defines typed slots. `registry.ts` implements mounting, and `setup.ts` registers the browser service.

## Public API

`miniSlots` and `SlotMap` are available through the browser SDK.

## Dependencies

Uses [UI Runtime](../ui-runtime/README.md) to associate contributions with their originating browser plugins.

## Lifecycle and ownership

`core:slots` owns its browser registry. Each mounted renderer receives a disposal signal.

Keyed registrations use `order` for display and `priority` for selection (higher wins, equal priorities conflict). Each selected renderer gets a fresh signal and releases it when replaced or removed.

## Testing

`tests/registry.test.ts` covers order, replacement, disposal and staged failures.

## Usage

Import [`mini-harness/ui-slots`](src/browser/api.ts). Define an empty outlet with `miniSlots.define(name, container, kind)` (list by default); register a node or renderer with `miniSlots.register(name, contribution, options)`. Both return disposers. Contributions can precede the outlet. Order sorts ascending and higher priority wins for the same key; equal priorities conflict. Removing a replacement restores the prior contribution. Each renderer owns its view signal and may return a node plus a disposer.

See the [composer replacement example](../../docs/examples/browser-panel/web/composer.ts).

## Related documentation

[Package index](../README.md) · [Frontend](../../docs/subsystems/frontend.md)
