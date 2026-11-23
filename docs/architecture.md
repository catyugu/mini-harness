# Architecture

mini-harness publishes **one npm package**. Internally, every folder under `packages/` is a private package with its own `package.json`, but these are **not** separately released or installed as npm workspaces. The root npm manifest and lockfile own the actual runtime dependency installation. Cordis owns service injection and plugin lifecycle; the **official Pi SDK** owns agent execution, model access, and conversation history. A capability is defined by what it owns, not by the number of source files.

## Responsibility boundaries

| Owner | Responsibility |
| --- | --- |
| `packages/kernel/mounts.ts` | Generic Cordis fiber mount, dependency-sensitive remount, reverse disposal and rollback. It knows nothing about Sessions, Agents, Workspaces, HTTP or app settings. |
| `packages/contracts/` | Implementation-free service, configuration, tool, route and transport types. Runtime configuration I/O belongs to `platform`. |
| `packages/plugins/` | Plugin discovery, manifest and configuration validation, and adaptation onto the generic fiber mount lifecycle. |
| `packages/host/application.ts` | Small composition root and public runtime facade. It injects service definitions but has no business algorithms. |
| `packages/<capability>/` | The actual business rules, Cordis providers, registered routes and optional browser entry. Each feature owns its lifecycle. |
| `packages/web/kernel/` | Generic outlet, command, tab, message-action and contribution registration with disposal. No concrete UI components. |
| `packages/web-app/application.ts` | Browser composition root (a private package separate from reusable `web`). `packages/web/ui/` owns reusable UI primitives and core browser plugins. |
| `packages/host/server.ts` | Local HTTP server: static assets, authorization, origin checking, process controls and registered route dispatch only. |

Essential services mount before optional user-facing plugins through `packages/host/composition.ts`. They are Cordis capabilities even though they have no on/off switches. Optional Subagents owns its semaphore and delegation provider. Runs delegates through the optional service when present, and runs directly when it is absent.

Plugin settings are uniformly stored under `settings.pluginConfig[pluginId]` and validated through the owning feature's schema. Settings publishes committed changes; consumers own live update hooks. Lifecycle-changing edits require idle runs, while the Subagents live policy can update without a remount.

## Internal package dependency graph

Every private `packages/<name>/package.json` declares **only** its direct internal edges, using `@mini-harness/<dependency>: file:../<dependency>`. These declarations describe the source graph and are not runtime package imports. TypeScript source continues to use explicit relative imports, and the root build emits one self-contained `dist/packages/` tree. There is no additional package manager workspace, build pipeline or versioning mechanism.

`test/system/architecture.test.ts` reads every manifest and traverses production TypeScript imports, including type-only imports, re-exports and static dynamic imports. It fails if any edge is undeclared, any declaration is unused, a package depends on the host or browser composition roots, or the internal graph contains a cycle. In particular, `contracts` cannot import `platform`, while the reusable `web` package cannot import feature-owned browser modules. Only `web-app` composes feature UI and only `host` composes server capabilities. Run `npm run check:deps` to verify these rules independently.

## Dependency rules

- The kernel may import Cordis and generic language/runtime utilities. It must not depend on configuration, transport, adapters or capabilities.
- A feature imports shared contracts and platform primitives, **not another feature's concrete files**. Cross-feature behavior is expressed by Cordis services and ports.
- Only application and browser composition roots import concrete feature entries.
- Browser modules may import server **types** from contracts, never server implementation values.
- Registration and cleanup belong to the same Cordis fiber. Publishing settings or UI events happens only after successful operations; rollback restores the previous scope set.

Deleting a registered workspace cascades through all its conversations and descendant Pi histories, while leaving the user's project directory untouched. Session deletion retains a minimal crash-recovery journal, not an archive.

## Test ownership and packaging

Feature-owned tests live under `packages/<id>/tests/`. Kernel and infrastructure tests live exclusively under `test/` (`test/plugins/` for plugin host and lifecycle tests, `test/settings/` for configuration, and `test/system/` for cross-capability journeys and architecture checks). Reusable browser UI tests live under `packages/web/ui/tests/`. Shared fixtures live under `test/support/`. Never place test files or `tests/` directories under production infrastructure directories. Tests must exercise real composition when service injection or disposal is the contract.

Run `npm run check` for compilation and co-located Node tests, `npm run test:browser` for all Playwright tests, and `npm run pack:check` for clean-package installation and launch. Build output is one package; the package allowlist excludes all `tests/` folders from the published tarball.
