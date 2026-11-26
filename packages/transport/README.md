# Transport

Provides HTTP route and upgrade registration, request lifetimes, and projection-change notices. It owns transport mechanics; feature plugins own payload validation and domain operations. Host owns the listener and surrounding authentication policy.

## Native composition and public API

The base Profile enables `@mini-harness/transport-runtime` to provide `harnessChanges`. The web Profile adds `@mini-harness/http-routing` for `harnessRoutes` and `harnessUpgrades`. Both declarations are in [`runtime.ts`](src/runtime.ts); neither has configuration.

External server plugins import [`mini-harness/transport`](src/routes.ts) for `RoutePort`, `RouteRequest`, `HttpError`, `HttpReply`, upgrade contracts and the trusted network-forwarding contract. Register routes in Cordis effects:

```ts
import type { Context } from 'mini-harness/cordis';
import { HttpReply } from 'mini-harness/transport';

export const inject = ['harnessRoutes'];

export function apply(ctx: Context) {
  ctx.effect(() =>
    ctx.harnessRoutes.register(
      'GET',
      '/api/extensions/example/status',
      () => new HttpReply(200, { ready: true }),
    ),
  );
}
```

The [greeting route example](../../docs/examples/greeting-route/plugin.ts) shows a route consuming another plugin's service.

## Routes, errors and cancellation

Routes match an HTTP method and literal or named-parameter path. Duplicate method/path registrations are rejected; literal paths take precedence over parameterized paths. Parameters are URL-decoded, and malformed encoding is rejected.

A `RouteRequest` provides the URL, parameters, Node request/response, an abort signal and a bounded JSON `body(max?)` reader. The handler must validate its own payload. An ordinary return value becomes JSON with status 200; `HttpReply` supplies another status and headers. `HttpError` expresses an expected failure using the shared error-code/status mapping. A handler that writes to `response` directly owns that response's framing.

The request signal combines client disconnect, route-work cancellation and application shutdown. A route's asynchronous disposer first removes admission, then cancels and drains its pending handler work. A handler removing its own route is excluded from that drain to avoid waiting on itself. Keep any dependent resource alive until the disposer resolves.

Handler work ends when its returned promise settles. A stream or upgraded connection that outlives that promise needs its own cleanup tied to the response/socket and feature lifetime; the route registry does not infer this lifetime from the open connection. Application shutdown seals all route admission, aborts active requests and ends open responses. Upgrade dispatch similarly provides a connection signal and drains pending handler work when unregistered.

## Projection changes

The native [`harnessChanges` contract](src/projection-api.ts) registers domains, increments revisions on invalidation and publishes snapshots or change notices with an optional resource ID. Registering a domain and subscribing to notices both return disposers. Revision counters remain process-local; notices carry no authoritative feature payload and are not durable history.

Features own the corresponding snapshot routes. [UI Gateway](../ui-gateway/README.md) streams notices, and [UI Runtime](../ui-runtime/README.md) routes them to browser projection owners. The internal [`eventStream`](src/http.ts) helper uses newline-delimited JSON with heartbeats and closes slow readers when buffered output exceeds its limit. It is not a separate public SDK export.

## Verification

[Plugin lifecycle tests](../../test/plugins/lifecycle.test.ts) cover route and upgrade disposal, body cancellation and self-removal. [Navigation/shutdown tests](../../test/system/navigation-shutdown.test.ts) verify active-request cancellation and projection-stream closure. [API tests](../../test/system/api-features.test.ts) cover trusted forwarding through the common route registry.

See [Host](../host/README.md), [Platform](../platform/README.md), [security](../../SECURITY.md), and the [transport subsystem](../../docs/subsystems/transport.md).
