# @mini-harness/tools

Owns tool registration, validation and invocation leases.

## Responsibilities

Resolves registrations through opaque runtime scope layers shared with Prompt. `forSession(id, scope)` selects contributions for the supplied runtime key; the session ID binds the tool's input environment. The tool policy remains a separate domain service. The registry rechecks each lease after asynchronous authorization.

## Structure

`src/api.ts` defines tool inputs and results. `events.ts` declares the tool policy event and `registry.ts` owns leases.

## API

`harnessTools.register` owns registration and `defineTool` infers argument types. `tools/decide` can deny an invocation.

## Dependencies

Uses Cordis fibers for plugin-owned calls and session ancestry for tool visibility. Agent consumes tool definitions and invocation leases.

## Lifecycle

`core:tools` mounts at application scope. Unmount revokes contributed definitions and waits for active invocations to drain.

## Configuration

Sessions supplies an optional `harnessToolPolicy`, interpreting the inherited conversation mode and the declared read-only property. Tools runs without this provider or any session service.

## Testing

`tests/registry.test.ts` covers visibility and leases. [Agent tests](../agent/tests/) cover dispatch and scheduling.
