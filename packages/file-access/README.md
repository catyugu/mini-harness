# @mini-harness/file-access

Provides file operations anchored to a directory.

## Responsibilities

Checks path containment and protects application storage. Callers resolve the directory before opening it.

## Structure

`src/api.ts` defines the access port, `root.ts` implements it, and `manifest.ts` mounts it.

## API

`harnessFileAccess.open(root)` returns a `RootedFileAccess` handle for the supplied directory.

## Dependencies

Uses [Platform](../platform/README.md) for path checks and the application storage path.

## Lifecycle

`core:file-access` mounts at application scope and supplies rooted access on demand.

## Testing

[Files policy tests](../files/tests/policy.test.ts) exercise workspace boundaries and permitted writes.
