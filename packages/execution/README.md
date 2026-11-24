# @mini-harness/execution

Defines the request and result contracts for child-process execution.

## Responsibilities

Owns the data passed between the process executor, isolation provider and tool consumers.

## Structure

`src/request.ts` holds the request, output, result and execution option types.

## API

The `request` entry is an internal workspace contract used by Sandbox and Process Execution.

## Dependencies

Keeps the process and sandbox interfaces independent so either provider can be composed without a dependency cycle.

## Testing

[Process Execution tests](../process-execution/tests/sandbox.test.ts) exercise the shared request through the executor.
