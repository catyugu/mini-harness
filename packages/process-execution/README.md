# Process Execution

Process Execution owns subprocess creation, streaming stdio and termination. Callers choose the executable, arguments, environment and working directory. [Shell](../shell/README.md) owns command policy, timeouts and output aggregation; [Sandbox](../sandbox/README.md) can prepare an isolated command before launch.

## Public API and usage

Import [`mini-harness/process-execution`](src/api.ts) and inject `harnessProcess`. `start(command, signal?)` returns writable stdin, readable stdout/stderr and a `finished` promise:

```ts
// Inside a plugin with harnessProcess injected:
const child = ctx.harnessProcess.start(command, signal);
child.stdin.end();
const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
const status = await child.finished;
```

Consume stdout and stderr concurrently so one full pipe cannot block the process. End stdin when no more input will be sent. For unbounded or untrusted output, use streaming consumers with caller-owned limits instead of the illustrative buffers above.

A `ProcessCommand` invokes an executable directly; it does not interpret shell syntax. The caller explicitly selects a shell when needed. Omitting `env` uses Node's inherited environment; passing an environment supplies that environment to the child.

## Lifetime and errors

`finished` settles after the child and stdio close. A nonzero exit resolves with `{ code, signal }`; spawn failures reject. The caller interprets the exit status.

The provider combines the caller's signal with its own Fiber signal. Cancellation terminates the process group on POSIX and uses `taskkill /T /F` on Windows, with a direct-child fallback. The provider tracks completion so unload cancels and drains its processes. Consumers remain responsible for stream handling and their operation's cancellation policy.

The base Profile mounts `core:process`; this provider has no plugin configuration or persistent state. It can be replaced through Cordis. The [Process preview example](../../docs/examples/process-preview/plugin.ts) supplies the same capability without starting an actual process.

## Verification

[Process tests](tests/sandbox.test.ts) exercise concurrent streams, cancellation, timeouts and isolation composition. See [execution](../../docs/subsystems/execution.md), [scoped providers](../../docs/scoped-providers.md) and the [package index](../../docs/packages.md).
