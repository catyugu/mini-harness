# Platform

Platform contains small operating-system and filesystem mechanisms shared by the native packages. Consumers own the domain policy and persistence format built on those mechanisms. This package is a private workspace library: it has no activation entry, plugin configuration or public root SDK export.

## Internal contracts

| Module                                   | Contract and use                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [runtime-paths.ts](src/runtime-paths.ts) | The `Paths` data contract and `harnessState.paths` declaration. [Host](../host/README.md) supplies the service.                                                                                                             |
| [paths.ts](src/paths.ts)                 | `getPaths` derives application paths from the working directory and `MINI_HARNESS_HOME`; `ensurePaths` prepares private directories. `containsPath` is a lexical containment check, not a filesystem confinement guarantee. |
| [json.ts](src/json.ts)                   | `readJson` returns a clone of the fallback only when a file is absent. Malformed JSON and other read failures propagate. `writeText` and `writeJson` write a private temporary file, sync it and rename it into place.      |
| [errors.ts](src/errors.ts)               | `DomainError` carries an operational error code and a client-suitable message. Boundary owners translate it to their transport or UI representation.                                                                        |
| [local-secret.ts](src/local-secret.ts)   | `protectLocal` invokes Windows CurrentUser data protection. Secret owners choose where to store the result and handle non-Windows storage policy.                                                                           |
| [wait.ts](src/wait.ts)                   | `waitFor` cancels a caller's wait when its signal aborts while allowing the owner of the underlying operation to finish settlement.                                                                                         |

For example, an internal persistence owner uses `writeJson` after validating its domain record. It must not treat `readJson<T>` as a validator: the generic type describes the caller's expected data, and parsed data still needs the owner's validation.

## Ownership and limitations

The default application directory is `~/.mini-harness`; `MINI_HARNESS_HOME` changes it. Per-workspace path derivation is a storage-location mechanism. [Workspaces](../workspaces/README.md) owns canonical workspace identities, and [Sessions](../sessions/README.md) owns conversation storage and recovery.

Atomic file replacement does not provide a multi-file transaction, a domain lock or session-log durability. Those guarantees belong to the caller. Native filesystem access has the host process's permissions; consumers that accept relative file paths use [File Access](../file-access/README.md) for a confined view. Process creation and lifetime belong to [Process Execution](../process-execution/README.md).

## Testing

These mechanisms are exercised through their consumers: [Profile tests](../../test/system/profiles.test.ts), [workspace API tests](../../test/system/workspace-api.test.ts), [file-policy tests](../files/tests/policy.test.ts), and [process tests](../process-execution/tests/execution.test.ts). Use the [development guide](../../docs/development.md) for focused checks and installed-package verification.
