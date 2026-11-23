# Security model

mini-harness binds to `127.0.0.1`. Its HTTP API requires a bearer token and checks the Origin on state-changing browser requests. The server state file contains the token. Keep the configuration directory private.

## Workspace and execution

- The native file tools and workspace browser use the same File Access provider. They restrict access to the active workspace and exclude mini-harness storage. Explicit file operations reject links, junctions, nonregular files and files with multiple hard links. Linux opens directories relative to pinned descriptors and verifies the resolved location and file identity before using it. Keep workspace directories under your control when other local actors can rename or remount them.
- Windows and other non-Linux platforms check resolved paths, link types and file identity before I/O. These checks assume the workspace is protected from concurrent path changes by untrusted local processes. They provide workspace-level restrictions in a trusted local environment. OS-level containment against concurrent local filesystem manipulation requires a platform-specific sandbox.
- Shell starts disabled. When enabled, each built-in Shell operation waits for explicit Web approval, expiring after five minutes; cancellation rejects pending approval. Linux isolated mode requires bubblewrap at `/usr/bin/bwrap`, working namespaces and `prlimit`. Isolated requests fail on hosts without these capabilities. It uses a separate PID and network namespace, clears the environment, exposes the workspace read-write and a limited set of system paths read-only, and applies per-process CPU, file size and descriptor limits. Separate the workspace from the configuration directory. On Linux, timeout, cancellation and output limits terminate the process group. Per-process limits do not constitute a system-wide resource quota.
- Trusted host mode runs with your user permissions. On Windows, command-tree termination uses `taskkill` while the parent process exists. Local Cordis JavaScript plugins run in-process with your user permissions on every platform. A replacement File Access, Process Execution or Sandbox provider is part of the trusted computing base. Enable only reviewed plugins. Optional `web.js` extensions run as trusted browser code and can use the authenticated API. GUI installation keeps new plugins disabled until enabled in Settings. Skills supply instructions through the native loader; they do not execute JavaScript. Skill files must be regular files without symlinks or additional hard links, and discovery and reads are bounded. Review workspace Skills before use.

## Data

Native JSONL session logs live under `~/.mini-harness/sessions`. Deleting an indexed conversation recursively removes its descendants and their owned files. Backups, filesystem snapshots and provider-side logs are controlled outside mini-harness.

Provider credentials can come from the environment or `~/.mini-harness/auth.json`. Image and text attachments are stored in the native conversation and sent to the selected provider. Model requests send conversation content and selected tool results to the chosen provider.

Session messages and inbox acknowledgments are flushed before completion is reported. Checksums, sequence numbers and ancestry detect corrupt complete records; only an incomplete final write is discarded at recovery. Restart marks unfinished runs interrupted and never retries tools automatically. A tool interrupted before its result was committed has an unknown outcome; the next turn receives an explicit error result rather than silently rerunning it.

The one-time session importer validates old paths and all converted logs before switching the index. Source histories are deleted only after the native index is durable; an interrupted cleanup resumes on startup. Unsupported or corrupt histories stop migration without deleting the sources. There is no legacy execution mode or archive directory.
