# Sandbox

`harnessSandbox.prepare(command, options)` returns a command for Process Execution. The caller supplies the working directory inside the sandbox and can select filesystem mounts, resource limits and the environment. A mount supplies a host path, a sandbox path and an optional read-only flag.

The default backend is Linux bubblewrap. It reports unsupported isolation as an error. A Profile can replace the provider using Cordis.
