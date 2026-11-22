# Changes

## 0.3.0

- Compose core runtime, configuration, sessions, tools and Web services through Cordis. Manage workspace files as a plugin, preserve unchanged scopes, and roll back failed plugin changes with dependency-aware cleanup.
- Persist one recent main model; use Pi SDK model switching without resetting context. Update ordinary settings and child concurrency during runs. Configure local plugins from JSON Schema controls and save provider credentials through Pi.
- Keep runs alive across browser disconnects and navigation. Query status, reconnect from event cursors, cancel descendants, and permanently delete running conversation trees after cancellation.
- Display live conversation-tree states, support recursive navigation and batch export/deletion, improve touch targets, keyboard viewport sizing and safe areas, and ship PNG PWA icons and favicon.
- Extend SDK, plugin, model, concurrency, reconnection, desktop/tablet/mobile and clean-package coverage. Preserve native Linux/Windows and Node.js 22/24 CI.

The existing sandbox and file-access policy remain in place. Shell stays disabled by default; sandbox redesign, archives, recycle bins, marketplaces and profile systems are outside this release.

## 0.2.0

Initial mini-harness preview with Pi SDK conversations, native Skills, child agents, Cordis plugins, workspace tools, and detached CLI operation.
