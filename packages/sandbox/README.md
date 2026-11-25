# @mini-harness/sandbox

Prepares a subprocess command for isolated execution.

## Responsibilities

Owns the isolation plan and platform-specific setup. Process Execution owns running the prepared process.

## Structure

`src/linux.ts` implements the Linux provider, with its contract in `api.ts` and mounting in `manifest.ts`.

## API

`harnessSandbox.prepare(command, { cpuSeconds, mounts, signal })` returns a command for Process Execution. Mounts identify a host source, target path and read-only mode.

## Dependencies

Uses [Process Execution](../process-execution/README.md) and platform isolation discovery.

## Lifecycle

`core:sandbox` mounts at application scope. Isolation is prepared for the individual process request.

## Testing

[Process Execution tests](../process-execution/tests/sandbox.test.ts) cover isolation behavior.
