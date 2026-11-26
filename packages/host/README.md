# Host

Host turns a named Profile into a running Cordis application. It owns Profile file loading and persistence, the application lifetime, the local HTTP listener and the process controls used by the CLI. Domain services are activated by Profile entries.

## Usage

The supported user entry point is the root package's CLI:

```sh
mini-harness web --dump-config
mini-harness web --no-open --port 3838
```

The first command inspects the effective configuration without importing plugins. The second starts the Web Profile in the foreground. Use `--detached` for an independent process, then `mini-harness status` or `mini-harness stop` to inspect or stop it. All commands for an instance must use the same `MINI_HARNESS_HOME`.

[Profiles](../../docs/profiles.md) owns the named-package layout, YAML syntax, layer precedence and package-management workflow. [Getting started](../../docs/user/getting-started.md) covers end-user setup. Host has no public `mini-harness/host` SDK export; plugins consume the services declared by their dependencies instead of booting another application.

## Composition and ownership

- [profile.ts](src/profile.ts) resolves the Profile's layers and module locations, creates its Cordis `EntryTree`, and persists accepted configuration to `cordis.patch.yml`. The [Plugins](../plugins/README.md) runtime validates and reconciles a candidate graph before asking this owner to commit it.
- [application.ts](src/application.ts) creates the root `Context` and supplies `harnessState`, `harnessProfile` and `harnessLaunch`. It returns the context and an idempotent asynchronous `close()` operation for internal callers.
- [web.ts](src/web.ts), [server.ts](src/server.ts) and [instance-credential.ts](src/instance-credential.ts) implement separately configured Web server and authentication entries. The listener delegates feature routes and upgrades to [Transport](../transport/README.md), and declared plugin assets to the plugin catalog.
- [process.ts](src/process.ts) owns the configuration-directory instance lock and authenticated process-status/shutdown requests. Process metadata is an observation of the running instance, not the lock itself.

The root CLI owns terminal signals and detached child launch. A custom Profile can compose native plugins without the Web server or plugin-management UI; installing an npm dependency alone does not activate it.

## Lifecycle and failures

Boot mounts the selected entries, emits `harness/start`, then emits `harness/open`. The plugin runtime uses `harness/ready` while preparing domain scopes. Failed entries can be exposed through plugin diagnostics when that runtime is available; otherwise initial entry failures reject boot. A failed boot closes its partial application.

Shutdown emits `harness/seal`, awaits `harness/quiesce`, awaits `harness/drain`, and finally closes the Profile tree. Cleanup still advances to the later stages when an earlier stage fails. Feature plugins participate through these events and Cordis-owned effects; they do not independently close the shared root.

The HTTP server binds to loopback, defaults to port `3837`, and supports the Web arguments `--port` and `--no-open`. Its live configuration handler rejects listener changes with a restart-required conflict. Detachment must be allowed by the Profile and reports success only after the child passes an authenticated readiness check. Port collisions and startup failures release the instance lock.

## Testing

[Profile tests](../../test/system/profiles.test.ts) cover layer composition, standalone native entries and persistence. [Detached-process tests](../../test/system/detached.test.ts) cover readiness, locking and port collisions. The authentication and trusted-plugin boundaries are documented in [SECURITY.md](../../SECURITY.md); the broader startup flow is in [composition](../../docs/subsystems/composition.md).
