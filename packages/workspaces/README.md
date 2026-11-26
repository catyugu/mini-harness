# Workspaces

Workspaces owns registered project roots, stable workspace identities, labels and ordering. It supplies workspace scopes and a live catalog projection. [Conversation](../conversation/README.md) owns browser navigation and selected conversations; [Sessions](../sessions/README.md) owns conversations attached to a workspace.

## Public API and usage

The `mini-harness/workspaces` export declares `WorkspacePort` and `harnessWorkspaces`. A consumer injects that service and uses the catalog rather than deriving its own workspace IDs:

```ts
import type { Context } from 'mini-harness/cordis';
import 'mini-harness/workspaces';

export function registerProject(ctx: Context, absolutePath: string) {
  return ctx.harnessWorkspaces.register(absolutePath, 'My project');
}
```

Registration canonicalizes an existing absolute directory, reuses its identity if already registered, and persists a new catalog record otherwise. The configuration directory and its descendants cannot be workspace roots. `get` reports a missing workspace; `resolveRoot` verifies that a root still resolves to the registered identity. Consumers should call `assertAvailable` before starting work that must not race workspace removal.

The [server API](src/server/api.ts) also exposes listing, renaming, complete-order replacement, browsing and removal participation. `reorder` requires every currently registered ID exactly once. `beforeRemove` registers asynchronous domain cleanup and returns a disposer; final removal remains owned by the catalog's HTTP workflow.

## Activation and projections

The base Profile's `core:workspace` entry mounts `@mini-harness/workspaces`. It requires application paths, Profile scope/configuration services and `harnessChanges`; HTTP routes are registered when `harnessRoutes` is present. The separate `core:workspaces-data` browser entry provides `miniWorkspaces`, a read projection consumed by browser features.

The [server setup](src/server/setup.ts) publishes the `workspaces` projection and the `/api/workspaces` routes. Catalog changes invalidate the projection; membership changes also notify Profile scope composition. Plugins that need to offer workspace-scoped configuration can use the domain's `workspace:<id>` address instead of maintaining another identity table.

There is no plugin-specific Config schema. The registry persists to `workspaces.json` under the application home. On first creation it registers the startup working directory; later starts preserve the saved catalog. `defaultId` prefers the startup directory if registered, then the first saved workspace.

## Removal and lifetime

Removing a workspace marks it unavailable, awaits registered domain participants, forgets its Profile scope and persists the shortened catalog. Sessions participates by draining and permanently deleting the workspace's conversation trees. The actual project directory and its files stay on disk.

A disconnected HTTP client stops waiting for removal; the catalog still owns settlement of the admitted operation. Shutdown rejects new removals and drains admitted removals. Runtime scope keys stay stable for the resource's application lifetime across service reactivation and are released when the resource is removed.

File-facing features share the internal [workspace file resolver](src/server/file-request.ts): it verifies a requested session belongs to the workspace, prepares the selected resource scope, resolves the current File Access provider and excludes private harness state. [File Access](../file-access/README.md) owns directory confinement; individual features own their content limits and presentation.

## Testing

[Workspace API tests](../../test/system/workspace-api.test.ts) cover identity, registration, ordering, persistence and cleanup. [Scoped-provider tests](../../test/plugins/composition.test.ts) cover provider resolution, and [session registry tests](../sessions/tests/registry.test.ts) cover dependent conversation deletion. See [configuration](../../docs/configuration.md) and [session coordination](../../docs/subsystems/sessions.md) for the surrounding flow.
