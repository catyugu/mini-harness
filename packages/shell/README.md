# Shell

Shell contributes the `sandbox_shell` tool and its command-result renderer. It owns workspace command construction, approval policy, timeout and bounded output. [Process Execution](../process-execution/README.md) owns the child process; [Sandbox](../sandbox/README.md) prepares isolation.

## Activation and configuration

Shell is disabled in the base Profile. Enable the `shell` entry in Plugins, then choose its execution mode. The [schema](src/manifest.ts) defines:

| Setting          | Behavior                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`           | `isolated` uses Linux bubblewrap; `host` executes with the application's host permissions. The initial default depends on detected isolation support. |
| `timeoutSeconds` | Command timeout, default 60 seconds, allowed range 1–300.                                                                                             |

Configuration belongs to the Shell entry. Conversation permission determines whether confirmation is required and whether tool policy permits execution; it does not change the configured isolation mode.

The `sandbox_shell` tool accepts a nonempty command string and is exposed only for conversations bound to a workspace. It is serial by default. Plugins can resolve the same definition through Tools and invoke it through `startTool`; there is no separate public Shell SDK.

## Approval and execution

Standard conversations request confirmation through [Approvals](../approvals/README.md). Full access skips the prompt for that conversation and can release an opted-in pending request. Policy is checked again before execution. Repeating a denied command within the same run does not reopen an identical approval.

In isolated mode, Shell requires a canonical workspace separate from protected application storage, mounts it at `/workspace`, and mounts attachments read-only at `/attachments`. It uses a limited environment and configured resource limits. Failure to prepare isolation is an error; it never silently retries on the host.

Host mode uses `/bin/sh` on POSIX or `cmd.exe` on Windows with the host environment. `MINI_HARNESS_ATTACHMENTS` points to available attachment storage. See [SECURITY.md](../../SECURITY.md) for the consequences of host execution and Full access.

## Output, cancellation and ownership

Shell drains stdout and stderr concurrently, records their channels in task output and bounds combined captured output to 1 MiB. Timeout, caller cancellation or excess output terminates the process. The result exposes exit status, stdout/stderr, a termination reason and truncation status; callers inspect these fields rather than treating every resolved tool result as a successful command.

Inline calls follow their enclosing Task. An explicit independent invocation uses its supplied resource owner and retention policy. For retained invocations, output lives in task channels without duplicating it in the compact task result. Pending confirmation still follows the [approval request lifetime](../approvals/README.md#ownership-and-lifetime). Unloading the tool registration cancels and drains active calls.

Shell invalidates the workspace file projection after execution. Its browser contribution renders command details through Conversation; it does not own a second process or file store.

## Dependencies and verification

The server requires Sessions, application state, Approval Requests, Process Execution, Tools and change notifications. Sandbox is required only when isolated mode executes.

[Approval tests](tests/approval-api.test.ts) cover decisions, permissions, cancellation, repeated denial and independent calls. [Process tests](../process-execution/tests/sandbox.test.ts) cover limits and isolation. See [execution](../../docs/subsystems/execution.md) and the [package index](../../docs/packages.md).
