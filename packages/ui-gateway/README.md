# @mini-harness/ui-gateway

Provides the HTTP interface used by the browser runtime to bootstrap and observe changes.

## Responsibilities

Owns `GET /api/bootstrap` and `GET /api/changes`. Plugins owns the graph and Transport owns revisions.

## Structure

`src/manifest.ts` declares the gateway. `src/setup.ts` binds HTTP routes and stream cleanup.

## API

The descriptor is consumed by Host. The browser consumes the graph and revision wire contracts.

## Dependencies

Uses [Plugins](../plugins/README.md) for the graph, [Transport](../transport/README.md) for changes and [UI Runtime](../ui-runtime/README.md) for bootstrap types.

## Lifecycle

`core:ui` owns the routes and ends streams when the transport shuts down.

## Testing

[Browser graph and projection suites](../../test/system/) exercise bootstrap, revision sync and shutdown.
