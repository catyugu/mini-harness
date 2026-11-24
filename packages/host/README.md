# @mini-harness/host

Composes the runnable application and manages its HTTP server and process lifetime.

## Responsibilities

Owns the root Cordis context, built-in descriptor list, local instance credentials, detached process control, upgrade dispatch and mutation coordination.

## Structure

`src/composition.ts` selects built-ins. `application.ts` owns the runtime, `server.ts` handles HTTP and static delivery, and `process.ts` handles detached instances.

## API

Host entry points serve the CLI and system fixtures. Feature packages receive capability services rather than importing Host.

## Dependencies

Combines [Plugins](../plugins/README.md), [Settings](../settings/README.md), [Transport](../transport/README.md) and feature descriptors. Provides trusted tool registration authority during assembly.

## Lifecycle

Starts the plugin graph before serving requests. On shutdown it stops admission, drains active runs and mutations, and disposes fibers and streams.

## Testing

[Detached and shutdown tests](../../test/system/) and `pnpm run pack:verify` exercise the executable entry points.
