# Cordis in mini-harness

The [vendored implementation](../vendor/cordis/README.md) is shared by Node and the browser and is exported as `mini-harness/cordis`. Consult its source for exact framework contracts; the public plugin SDK adds product contracts, not a replacement lifecycle system.

## Native framework mechanisms

A Context is the service and event lookup environment. A Fiber owns an activation of a plugin. Declare required services with `inject`, provided services with `provide`, and supply `apply(ctx, config)`. Missing dependencies leave the consumer waiting. Use `ctx.provide(name, value)` to supply a service; `ctx.get(name)` is appropriate for intentional optional dependencies. Type service contracts by augmenting the public Cordis module.

An effect owns registrations and their disposers: `ctx.effect(() => service.register(...))`. Event listeners registered by `ctx.on` are activation-owned. Events are dispatched in registration order unless explicitly prepended; the event owner selects scope and dispatch semantics. Do not invent an application-wide plugin event bus.

## Local runtime contracts

Each activation has a cancellation signal (`ctx.fiber.signal`). Use `ctx.fiber.run(work, requestSignal)` for asynchronous work whose completion must be drained during disposal. Teardown aborts and drains tracked work, then releases effects. Injected services stay available while their dependents dispose.

Entry Trees reconcile named entries against a new configuration. Native Config schemas validate effective configuration; the Entry holds raw and effective values. Loaded Fibers receive `internal/update` and a listener can handle or reject the candidate. Without a handling listener, the default behavior accepts live updates in place and restarts non-live activations. Nested fibers read their owning Entry's configuration but retain their own lifetime.

For differences from upstream, see the [vendored source and local changes](../vendor/cordis/README.md) and [framework tests](../test/framework/cordis.test.ts).

## Product-specific mechanisms

Host resolves Profile layers and persists accepted configuration. Plugins bind configured resource scopes and publish browser assets. Runtime scope keys and persistent Profile addresses are distinct; see [scoped providers](scoped-providers.md). Feature services own their own state. The browser has its own Context and fibers; the transport connects it to the server rather than sharing server objects.

Read [composition](subsystems/composition.md) for the full application flow and [create a plugin](cookbook/creating-a-plugin.md) for an end-to-end example.
