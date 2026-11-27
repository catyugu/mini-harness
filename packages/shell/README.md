# Shell

Shell contributes the `shell` tool and its command-result renderer. It owns workspace command construction, command timeout and output capture. [Process Execution](../process-execution/README.md) owns the child process.

## Activation and configuration

Shell is disabled in the base Profile. Enable the `shell` entry in Settings → Built-in plugins to authorize native command execution with your user permissions. Its configuration view is available in Plugins while enabled. Commands use the host environment, working directory and network. Standard and Full access conversations execute enabled Shell calls without per-command confirmation; read-only conversations and descendants cannot use Shell. See [SECURITY.md](../../SECURITY.md).

The [configuration schema](src/manifest.ts) defines:

| Setting          | Behavior                                                                           |
| ---------------- | ---------------------------------------------------------------------------------- |
| `timeoutMs`      | Default command timeout in milliseconds (120000).                                  |
| `maxOutputBytes` | Maximum captured bytes per stream (64000). Remaining bytes go to a temporary file. |

The `shell` tool accepts a nonempty `command` and an optional `timeoutMs` override, including when invoked independently through `start_background`. For long builds or tests, an agent can submit:

```json
{ "tool": "shell", "arguments": { "command": "pnpm run build", "timeoutMs": 600000 } }
```

Shell uses `/bin/sh` on POSIX or `cmd.exe` on Windows. `MINI_HARNESS_ATTACHMENTS` points to available attachment storage. The selected scoped `harnessProcess` provider determines how a command runs; there is no built-in isolation layer.

## Output and lifetime

Shell drains stdout and stderr concurrently, retaining up to the configured limit independently for each stream. Remaining bytes are saved in separate files under the system temporary directory. The result exposes `stdoutOverflow` and `stderrOverflow` paths when applicable. Output limits do not terminate the command. Temporary files remain available for inspection until removed by the user or system temporary-file cleanup.

Foreground calls follow their caller's signal. Independent tasks stream output through their task channels and retain compact process status and overflow paths in the task result. Timeout, cancellation or plugin unload terminates the process through the Process Execution provider. Shell invalidates the workspace file projection after execution.

[Shell integration tests](../../test/system/shell.test.ts) cover tool permissions, native execution and independent calls. [Command tests](tests/command.test.ts) cover cancellation, timeouts and overflow files. [Process tests](../process-execution/tests/execution.test.ts) cover concurrent streams.
