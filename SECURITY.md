# Security model

mini-harness binds to `127.0.0.1`. Its HTTP API requires a bearer token and checks the Origin on state-changing browser requests. The server state file contains the token. Keep the configuration directory private.

## Workspace and execution

- The Pi file tools use one workspace policy on Linux and Windows. They restrict access to the active workspace and exclude mini-harness storage. Explicit file operations reject links, junctions, nonregular files and files with multiple hard links. Linux walks directories relative to open descriptors and validates the opened file before using it.
- Windows and other non-Linux platforms check resolved paths, link types and file identity before I/O. These checks assume the workspace is protected from concurrent path changes by untrusted local processes. They provide workspace-level restrictions in a trusted local environment. OS-level containment against concurrent local filesystem manipulation requires a platform-specific sandbox.
- Shell starts disabled. When enabled, each built-in Shell operation waits for explicit Web approval, expiring after five minutes; cancellation rejects pending approval. Linux isolated mode requires working bubblewrap namespaces and `prlimit`. It uses a separate PID and network namespace, clears the environment, exposes the workspace read-write and a limited set of system paths read-only, and applies per-process CPU, file size and descriptor limits. Separate the workspace from the configuration directory. Timeout, cancellation and output caps terminate the shell process group. Per-process limits do not constitute a system-wide resource quota.
- Trusted host mode runs with your user permissions. On Windows, command-tree termination uses `taskkill`. Local Cordis JavaScript plugins run in-process with your user permissions on every platform. Enable only reviewed plugins. Optional `web.js` extensions run as trusted browser code and can use the authenticated API. GUI installation keeps new plugins disabled until enabled in Plugins. Pi extension discovery is disabled, and Pi Skills can supply instructions to the model. Review workspace Skills before use.

## Data

Pi JSONL session files live under `~/.mini-harness/sessions`. Deleting an indexed conversation recursively removes its descendants and their owned files. Backups, filesystem snapshots and provider-side logs are controlled outside mini-harness.

Provider credentials can come from the environment or `~/.mini-harness/auth.json`. Image and text attachments are stored in the Pi conversation and sent to the selected provider. Model requests send conversation content and selected tool results to the chosen provider.
