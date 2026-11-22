# Changes

## Unreleased

- Unify palette, semantic tokens, surface elevation, independent text/code/terminal sizes, focus and reduced-motion behavior.
- Add scoped list and keyed contribution regions with deterministic priority, Chat matching and lifecycle restoration.
- Give workspaces persisted identities, safe relocation and confirmed cascading deletion; restore formerly hidden legacy sessions and persist per-session resource tabs.
- Project Chat and Trajectory from Pi entry identities, arguments, results and measured tool durations; preserve final answers outside process folding and omit incomplete round usage.
- Add a session Todo plugin and replaceable composer docks; retain user-level Skills with workspace > application > user conflict precedence.
- Isolate test HOME/USERPROFILE, expand Linux/Windows browser coverage, and test tasks, trajectory, resource links, plugin replacement and large-font/mobile layouts.

- Add five frontend extension points with owned mount/disposal, shared plugin configuration, dependency ordering and custom tool renderers. Split requests, settings, conversations, message rendering, attachments and file inspection into browser modules.
- Add neutral light/dark surfaces, consistent icons, a collapsed navigation rail, grouped settings, an input-level model selector and a single file inspector.
- Configure provider catalogs, credentials and custom API endpoints from Settings; switch local workspaces while idle. Foreground startup opens a browser unless `--no-open` is supplied.
- Attach images and UTF-8 text, find files with `@`, invoke native Skills, copy messages, retry failed image submissions, and queue Pi steering/follow-up messages during runs.
- Inspect tool arguments/results, workspace files, staged/unstaged Git diff and successful file edits. Request one-time approval for built-in Shell commands.
- Keep empty drafts out of persistent history; search, rename and delete conversation trees. Install disabled local plugin bundles and permanently uninstall them from Plugins.
- Add behavior tests for the GUI and API, including narrow viewports, reduced viewport height and both color schemes.

## 0.3.0

- Compose core runtime, configuration, sessions, tools and Web services through Cordis. Manage workspace files as a plugin, preserve unchanged scopes, and roll back failed plugin changes with dependency-aware cleanup.
- Persist one recent main model; use Pi SDK model switching without resetting context. Update ordinary settings and child concurrency during runs. Configure local plugins from JSON Schema controls and save provider credentials through Pi.
- Keep runs alive across browser disconnects and navigation. Query status, reconnect from event cursors, cancel descendants, and permanently delete running conversation trees after cancellation.
- Display live conversation-tree states, support recursive navigation and batch export/deletion, improve touch targets, keyboard viewport sizing and safe areas, and ship PNG PWA icons and favicon.
- Extend SDK, plugin, model, concurrency, reconnection, desktop/tablet/mobile and clean-package coverage. Preserve native Linux/Windows and Node.js 22/24 CI.

The existing sandbox and file-access policy remain in place. Shell stays disabled by default; sandbox redesign, archives, recycle bins, marketplaces and profile systems are outside this release.

## 0.2.0

Initial mini-harness preview with Pi SDK conversations, native Skills, child agents, Cordis plugins, workspace tools, and detached CLI operation.
