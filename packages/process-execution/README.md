# @mini-harness/process-execution

Implements the process execution capability and enforces output, timeout and cancellation limits.

## Responsibilities

Chooses the execution environment for a request and captures process results. Shell supplies approval policy and Sandbox prepares isolation.

## Structure

`src/executor.ts` implements execution. `api.ts` defines the port and `manifest.ts` publishes it.

## API

`harnessProcess` and `ProcessExecutionPort` expose execution to authorized callers.

## Dependencies

Uses [Execution](../execution/README.md) for requests and [Sandbox](../sandbox/README.md) for isolated execution preparation.

## Lifecycle

`core:process` mounts at application scope. Requests carry cancellation and output limits.

## Testing

`tests/sandbox.test.ts` exercises execution limits and isolation on supported runners.
