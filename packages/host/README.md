# @mini-harness/host

Composes the runnable application and manages its HTTP server and process lifetime.

## Responsibilities

Owns the root Cordis context, built-in descriptor list, local instance credentials, detached process control, upgrade dispatch and mutation coordination.

## Structure

`src/composition.ts` selects built-ins and specifies required capabilities and protected provider identities. `application.ts` owns the runtime, `server.ts` handles HTTP and static delivery, and `process.ts` handles detached instances.

## API

Host entry points serve the CLI and system fixtures. Feature packages receive capability services rather than importing Host.

## Dependencies

Combines [Plugins](../plugins/README.md), [Settings](../settings/README.md), [Transport](../transport/README.md) and feature descriptors. Provides trusted tool registration authority during assembly.

## Lifecycle

Waits for capability readiness before serving requests. Shutdown seals HTTP and mutation admission, waits for capability quiescence and drains outstanding requests and configuration transactions before releasing the graph. Upgrades use connection signals and wait for their asynchronous handlers.

## Testing

[Detached and shutdown tests](../../test/system/) and `pnpm run pack:verify` exercise the executable entry points.
