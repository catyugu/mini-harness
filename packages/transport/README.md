# @mini-harness/transport

Defines the native HTTP boundary and projection change transport.

## Responsibilities

Owns route registration, HTTP errors and replies, event streams, and projection revision tracking.

## Structure

`src/routes.ts` defines the contract, `router.ts` dispatches requests, and `http.ts` handles response framing. Projection changes live in `projections.ts` and their wire payload lives in `src/shared/projection-notice.ts`.

## API

`harnessRoutes` and `harnessChanges` are host services. Plugin-scoped routes use `PluginApi`.

## Dependencies

Uses Node HTTP and [Platform](../platform/README.md) errors. Features own payload validation and domain operations.

## Lifecycle

Route leases are revoked with their owner. Projection subscribers detach when the stream closes.

## Testing

[API and projection tests](../../test/system/) cover the authenticated runtime transport.
