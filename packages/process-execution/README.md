# @mini-harness/process-execution

Implements the process execution capability and enforces output, timeout and cancellation limits.

## Responsibilities

Starts the supplied executable and arguments in a working directory and captures the result. A caller can pass a command prepared by an execution environment such as Sandbox.

## Structure

`src/executor.ts` implements execution. `api.ts` defines the port and `manifest.ts` publishes it.

## API

`harnessProcess.run({ file, args, cwd, env, timeoutSeconds, signal })` runs a subprocess and returns its exit status and captured output.

## Testing

`tests/sandbox.test.ts` exercises execution limits and isolation on supported runners.
