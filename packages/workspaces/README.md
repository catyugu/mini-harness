# @mini-harness/workspaces

Owns workspace identities, canonical roots, labels and ordering.

## Responsibilities

Maintains the workspace catalog, manages directory browsing and provides the browser workspace projection. Conversation owns navigation and selection.

## Structure

`src/manifests/` declares workspace storage and data projection. `src/server/` contains the catalog and routes. `src/shared/` holds workspace records. `src/browser/` consumes the projection.

## API

`harnessWorkspaces` serves native capabilities. `miniWorkspaces` provides the browser catalog.

## Dependencies

Uses [Platform](../platform/README.md) for canonical paths and [Transport](../transport/README.md) for projection updates.

Workspace removal blocks new session work, drains deletion participants and clears workspace settings before removing the registry entry. The workspace directory is never deleted.

## Lifecycle

`core:workspace` owns the native catalog and `core:workspaces-data` owns its browser subscription.

## Configuration

The catalog is stored in `workspaces.json`. Users register, rename and reorder roots from the workspace controls.

## Testing

[Workspace API tests](../../test/system/workspace-api.test.ts) cover registration, ordering, persistence and removal.
