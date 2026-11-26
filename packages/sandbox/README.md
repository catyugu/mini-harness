# Sandbox

Sandbox prepares an isolated command for [Process Execution](../process-execution/README.md). It owns the translation from filesystem mounts, resource limits and an in-sandbox working directory to an executable command. It does not launch the process or choose conversation approval policy.

## Public API and usage

Import [`mini-harness/sandbox`](src/api.ts) and inject `harnessSandbox`. `prepare(command, options)` returns a `ProcessCommand`; pass that command to `harnessProcess.start`.

```ts
// Inside a plugin with harnessSandbox and harnessProcess injected:
const command = await ctx.harnessSandbox.prepare(
  { file: '/bin/sh', args: ['-c', 'pwd'], cwd: workspaceRoot },
  {
    workingDirectory: '/workspace',
    mounts: [{ source: workspaceRoot, target: '/workspace' }],
    signal,
  },
);
const child = ctx.harnessProcess.start(command, signal);
```

Consume and close the process streams according to the [Process Execution contract](../process-execution/README.md). A mount declares a host `source`, in-sandbox `target` and optional `readOnly`. Limits are expressed as CPU seconds, open-file count, file bytes and core bytes. The caller supplies the command environment; the backend does not inherit the host environment into the sandbox.

## Built-in backend and replacement

The base Profile's `core:sandbox` entry provides the Linux [bubblewrap backend](src/linux.ts). It creates isolated namespaces, drops capabilities, mounts system binaries read-only and supplies private temporary storage. Only explicitly selected application paths are mounted. Optional limits use `prlimit`.

Preparation checks Linux isolation support and fails when bubblewrap namespaces or required tooling are unavailable. An explicit isolated request never falls back to host execution. [Shell](../shell/README.md) separately chooses its configured host or isolated mode and supplies workspace/attachment mounts.

The provider has no plugin configuration or persistent state. A Profile can replace `harnessSandbox` through Cordis, including within a configured scope. The replacement must preserve the public preparation contract and document its own isolation guarantees.

## Verification

[Process and sandbox tests](../process-execution/tests/sandbox.test.ts) cover unsupported hosts and real isolation when available. [SECURITY.md](../../SECURITY.md) describes the shipped trust and filesystem model. See [scoped providers](../../docs/scoped-providers.md) and the [package index](../../docs/packages.md).
