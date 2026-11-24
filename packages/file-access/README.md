# @mini-harness/file-access

Enforces the workspace file access policy for features that inspect or modify files.

## Responsibilities

Resolves managed workspace paths and exposes scoped access operations. The Files plugin owns user-visible tools and inspection.

## Structure

`src/api.ts` defines the access port, `workspace.ts` implements it, and `manifest.ts` mounts it.

## API

`harnessFileAccess` and `WorkspaceFileAccess` are available through the server SDK.

## Dependencies

Uses [Workspaces](../workspaces/README.md) for canonical roots and [Platform](../platform/README.md) for path and file operations.

## Lifecycle

`core:file-access` mounts at application scope and supplies per-workspace access on demand.

## Testing

[Files policy tests](../files/tests/policy.test.ts) exercise workspace boundaries and permitted writes.
