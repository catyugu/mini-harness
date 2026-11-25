# @mini-harness/tools

Owns tool registration, validation and invocation leases.

## Responsibilities

Resolves scoped registrations and checks them against the host’s authorization policy. The registry rechecks each lease after asynchronous authorization.

## Structure

`src/api.ts` defines tool inputs and results. `events.ts` declares the tool policy event and `registry.ts` owns leases.

## API

`harnessTools.register` owns registration and `defineTool` infers argument types. The `tools/pre-execute` event can deny an invocation or return replacement arguments. The registry validates replacement arguments and rechecks authorization before executing. The host protects the provider.

## Dependencies

Uses Cordis fibers for plugin-owned calls and session ancestry for tool visibility. Agent consumes tool definitions and invocation leases.

## Lifecycle

`core:tools` mounts at application scope. Unmount revokes contributed definitions and waits for active invocations to drain.

## Configuration

Scoped `disabledTools` can restrict tools through an entire descendant tree.

The registry receives the mandatory tool policy through `harnessToolPolicy`. Sessions interprets inherited permissions and user restrictions, and the registry checks the selected registration again before execution.

## Testing

`tests/registry.test.ts` covers visibility and leases. [Agent tests](../agent/tests/) cover dispatch and scheduling.
