# Security model

mini-harness binds to `127.0.0.1` and requires a bearer credential on its API. The instance credential survives a restart. On Unix it is stored in an owner-only file. Windows protects the credential using DPAPI for the current user. The server metadata and detached log omit the credential. Run `mini-harness reset-token` to stop the instance and revoke its current credential.

## Workspace and execution

- Agent `read` and `ls` can access explicit paths using the selected File Access provider and its operating-system permissions, including paths outside the workspace. The workspace view used by writes, edits, search and the browser excludes mini-harness storage and checks resolved paths against the workspace root. It permits links to targets inside that view and regular hard-linked files. This is a workspace convenience boundary for trusted local development, not operating-system confinement.
- Shell starts disabled. Enabling it authorizes native commands with your user permissions, without per-command confirmation. Commands inherit the host environment and may access credentials and files outside the workspace or use the network. Run only trusted workspaces or isolate the harness externally. Timeout and cancellation terminate the process tree on a best-effort basis.
- Local Cordis JavaScript plugins run in-process with your user permissions on every platform. Replacing a default service through explicit Profile composition trusts the replacement. File Access and Process Execution providers are trusted code. Enable only reviewed plugins. Browser extensions run with access to the authenticated API. Installing a Profile dependency does not activate it; declare and enable the corresponding entry explicitly.
- Read-only conversations select registrations that declare read-only access, whether shipped or third-party. Descendants inherit read-only mode. This is a convention for normal agent tool execution, not an isolation boundary for trusted in-process JavaScript plugins. Process isolation for JavaScript plugins depends on the environment running the harness.
- The Skills plugin reads bounded instruction files and follows symbolic links and Windows junctions, including links outside configured roots. The file target must be regular and have one hard link. Workspaces and linked skill files may be controlled by an untrusted repository or another local user. Review their instructions and link targets before loading them. Skills discovery runs with the harness process's filesystem access. Shell uses native host permissions.

## Data

Native JSONL session logs live under `~/.mini-harness/sessions`. Deleting an indexed conversation recursively removes its descendants and their owned files. Backups, filesystem snapshots and provider-side logs are controlled outside mini-harness.

Provider credentials can come from the environment or `~/.mini-harness/auth.json`. Original uploads are stored within the owning conversation's managed directory. Supported images and bounded UTF-8 text are sent to the selected provider; other files are available to enabled Shell commands and are not automatically parsed. Model requests send conversation content and selected tool results to the chosen provider.

Session messages and inbox acknowledgments are flushed before completion is reported. Checksums, sequence numbers and ancestry detect corrupt complete records; only an incomplete final write is discarded at recovery. Restart marks unfinished runs interrupted and never retries tools automatically. A tool interrupted before its result was committed has an unknown outcome; the next turn receives an explicit error result rather than silently rerunning it.

The conversation catalog is validated at startup: invalid identities, unknown workspaces and broken ancestry are rejected instead of loading a partial index.

A trusted gateway plugin may expose a separately authenticated viewer. The gateway owns viewer authentication, route authorization, pairing credentials and listener lifecycle. The Host forwards any authorized registered route without a business-route allowlist; it still checks the forwarded Origin/Host and restricts shutdown to local access. A gateway that intends read-only access must enforce that policy itself.

The Profile YAML parser accepts data-only configuration layers. Disabled entries are not imported; npm lifecycle scripts are disabled by default. Browser entries receive their configuration. Store credentials in the existing secrets service rather than in browser configuration. Preview routes use the selected scoped File Access provider or the owning conversation’s attachment store. Media uses temporary Blob URLs. Uploaded markup is displayed as source or passed through the app’s sanitized Markdown renderer.
