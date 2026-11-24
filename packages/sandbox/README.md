# @mini-harness/sandbox

Prepares the isolated process environment for standard-permission conversations.

## Responsibilities

Owns the isolation plan and platform-specific setup. Process Execution owns running the prepared process.

## Structure

`src/linux.ts` implements the Linux provider, with its contract in `api.ts` and mounting in `manifest.ts`.

## API

`harnessSandbox` and `SandboxPort` allow the execution host to prepare isolation.

## Dependencies

Uses [Execution](../execution/README.md) and platform isolation discovery.

## Lifecycle

`core:sandbox` mounts at application scope. Isolation is prepared for the individual process request.

## Testing

[Process Execution tests](../process-execution/tests/sandbox.test.ts) cover isolation behavior.
