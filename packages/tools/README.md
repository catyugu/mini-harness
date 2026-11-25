# @mini-harness/tools

Owns tool registration, validation and invocation leases.

## Responsibilities

Resolves scoped registrations and checks them against the host’s authorization policy. The registry rechecks each lease after asynchronous authorization.

## Structure

`src/api.ts` defines tool inputs and results. `events.ts` declares the tool policy event and `registry.ts` owns leases.

## API

`harnessTools.register` owns registration and `defineTool` infers argument types. `tools/decide` composes allow, deny and ask decisions; denial wins. A definition can declare an approval prompt. The registry rechecks authority after approval.

## Dependencies

Uses Cordis fibers for plugin-owned calls and session ancestry for tool visibility. Agent consumes tool definitions and invocation leases.

## Lifecycle

`core:tools` mounts at application scope. Unmount revokes contributed definitions and waits for active invocations to drain.

## Configuration

Scoped `disabledTools` can restrict tools through an entire descendant tree.

Sessions supplies the default `harnessToolPolicy`, interpreting inherited permissions and per-Profile module-bound grants.

## Testing

`tests/registry.test.ts` covers visibility and leases. [Agent tests](../agent/tests/) cover dispatch and scheduling.
