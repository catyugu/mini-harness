# @mini-harness/tools

Owns tool registration, policy and invocation leases.

## Responsibilities

Resolves scoped registrations, applies restrictions and authorization decisions, and prevents revoked tools from executing.

## Structure

`src/api.ts` defines tool inputs and results. `extensions.ts` exposes contributions and `registry.ts` owns leases.

## API

`harnessTools`, `defineTool` and `toolExtensions` define registration and execution policy. The host protects the provider.

## Dependencies

Uses [Kernel](../kernel/README.md) for plugin lifetimes and scope selection. Agent consumes tool definitions and invocation leases.

## Lifecycle

`core:tools` mounts at application scope. Unmount revokes contributed definitions and waits for active invocations to drain.

## Configuration

Scoped `disabledTools` can restrict tools through an entire descendant tree.

The registry receives the mandatory tool policy through `harnessToolPolicy`. Sessions interprets inherited permissions and user grants, and the registry checks the selected registration again before execution.

## Testing

`tests/registry.test.ts` covers visibility and leases. [Agent tests](../agent/tests/) cover dispatch and scheduling.
