# @mini-harness/tools

Owns tool registration, validation and invocation leases.

## Responsibilities

Resolves tool registrations through opaque runtime scope layers shared with Prompt. A selected definition holds a lease that expires when its registration is replaced or unloaded.

## Structure

`src/api.ts` defines tool inputs and results. `events.ts` declares the tool policy event and `registry.ts` owns leases.

## API

`harnessTools.register` accepts a definition or a resource-specific factory. `harnessTools.list()` selects plain registrations. Pass `{ scope, resourceId }` to resolve scoped or resource-specific registrations. `defineTool` infers argument types from the schema.

## Dependencies

Uses Cordis fibers for plugin-owned calls and session ancestry for tool visibility. Agent consumes tool definitions and invocation leases.

## Lifecycle

`core:tools` mounts at application scope. Unmount revokes contributed definitions and waits for active invocations to drain.

## Configuration

Sessions supplies an optional `harnessToolPolicy`, interpreting the inherited conversation mode and the declared read-only property. Tools runs without this provider or any session service.

## Testing

`tests/registry.test.ts` covers visibility and leases. [Agent tests](../agent/tests/) cover dispatch and scheduling.
