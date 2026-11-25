# @mini-harness/transport

Defines the native HTTP boundary and projection change transport.

## Responsibilities

Owns route registration, HTTP errors and replies, event streams, and projection revision tracking.

## Structure

`src/routes.ts` defines the contract, `router.ts` dispatches requests, and `http.ts` handles response framing. Projection changes live in `projections.ts` and their wire payload lives in `src/shared/projection-notice.ts`.

## API

`harnessRoutes`, `harnessUpgrades` and `harnessChanges` are host services. All plugins use the same HTTP and upgrade registry; register routes in a Cordis effect to remove them on unload.

## Dependencies

Uses Node HTTP and [Platform](../platform/README.md) errors. Features own payload validation and domain operations.

## Lifecycle

Unregistering a route cancels and drains its active requests, except for the request that is itself removing the route. Related resources can be released after awaiting the route disposer in the same effect. Application shutdown seals route admission, cancels request work and ends open streams. Projection subscribers detach when their stream closes.

## Testing

[API and projection tests](../../test/system/) cover the authenticated runtime transport.
