# Changes

## Unreleased

- Reduce the generic kernel to Cordis lifecycle orchestration. Mount Pi Agent, Runs, Sessions, Workspaces, Models, Settings, Plugins and UI endpoints as individually owned capabilities; keep HTTP server as authentication, static assets and dispatch.
- Replace fixed Subagents/Shell settings routes with schema-validated `pluginConfig.<id>` and live child-agent configuration. Allow a disabled optional capability to remain unmounted even when its configuration is invalid, and remove stale configuration when uninstalling local plugins.
- Compose browser outlets, commands, tabs and settings pages from browser-owned Cordis services rather than fixed host callbacks. Keep capability tests beside their implementations, validate import boundaries and exclude test suites from the npm tarball.

- Consolidate message copy and Pi branch-aware edit/resend into the single `session-helper` Cordis feature, with one frontend lifecycle and one switch. Remove obsolete settings migration paths and duplicate message-submit routes.
- Isolate host/browser composition roots from capability contracts and implementations, co-locate file and Shell logic with their feature plugins, and permanently cascade workspace deletion to associated conversations without deleting project files.
- Allow plugin-specific SVG icon paths and arbitrary symbolic icon identifiers. Remove `agentResources` metadata and use one consistent plugin reconfiguration lifecycle.

- Add five frontend extension points with owned mount/disposal, shared plugin configuration, dependency ordering and custom tool renderers. Split requests, settings, conversations, message rendering, attachments and file inspection into browser modules.
- Add neutral light/dark surfaces, consistent icons, a collapsed navigation rail, grouped settings, an input-level model selector and a single file inspector.
- Configure provider catalogs, credentials and custom API endpoints from Settings; switch local workspaces while idle. Foreground startup opens a browser unless `--no-open` is supplied.
- Attach images and UTF-8 text, find files with `@`, invoke native Skills, copy messages, retry failed image submissions, and queue Pi steering/follow-up messages during runs.
- Inspect tool arguments/results, workspace files, staged/unstaged Git diff and successful file edits. Request one-time approval for built-in Shell commands without changing sandbox execution.
- Keep empty drafts out of persistent history; search, rename and delete conversation trees. Install disabled local plugin bundles and permanently uninstall them from Settings.
- Add behavior tests for the GUI and API, including narrow viewports and reduced viewport height; no image snapshot baselines.

## 0.3.0

- Compose core runtime, configuration, sessions, tools and Web services through Cordis. Manage workspace files as a plugin, preserve unchanged scopes, and roll back failed plugin changes with dependency-aware cleanup.
- Persist one recent main model; use Pi SDK model switching without resetting context. Update ordinary settings and child concurrency during runs. Configure local plugins from JSON Schema controls and save provider credentials through Pi.
- Keep runs alive across browser disconnects and navigation. Query status, reconnect from event cursors, cancel descendants, and permanently delete running conversation trees after cancellation.
- Display live conversation-tree states, support recursive navigation and batch export/deletion, improve touch targets, keyboard viewport sizing and safe areas, and ship PNG PWA icons and favicon.
- Extend SDK, plugin, model, concurrency, reconnection, desktop/tablet/mobile and clean-package coverage. Preserve native Linux/Windows and Node.js 22/24 CI.

The existing sandbox and file-access policy remain in place. Shell stays disabled by default; sandbox redesign, archives, recycle bins, marketplaces and profile systems are outside this release.

## 0.2.0

Initial mini-harness preview with Pi SDK conversations, native Skills, child agents, Cordis plugins, workspace tools, and detached CLI operation.
