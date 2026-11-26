# Package index

These private source packages are built into a single npm package. Locate the owning capability here before changing behavior. The categories are navigation, not package namespaces or an import graph. For the global dependency direction see [architecture](architecture.md); installed imports are defined in [root exports](../package.json).

## Composition and platform

- [host](../packages/host/README.md): Profile loading, launch and process lifecycle.
- [plugin-api](../packages/plugin-api/README.md): Shared plugin, configuration and scope contracts.
- [plugins](../packages/plugins/README.md): Module resolution, scope composition and browser asset publication.
- [settings](../packages/settings/README.md): Configuration editing and settings contributions.
- [platform](../packages/platform/README.md): Generic OS, path, JSON and secret-storage helpers.

## Execution

- [tasks](../packages/tasks/README.md): Business-independent async scheduling and task handles.
- [agent](../packages/agent/README.md): Native model-turn loop, prompts and compaction.
- [runs](../packages/runs/README.md): Conversation run submission and replay.
- [llm](../packages/llm/README.md): Native model protocol and adapter selection.
- [models](../packages/models/README.md): Model catalog, provider data and model preference.
- [tools](../packages/tools/README.md): Tool registration and invocation.
- [subagents](../packages/subagents/README.md): Child conversation delegation policy.

## Data and identity

- [sessions](../packages/sessions/README.md): Conversation identity, history, attachments and deletion.
- [workspaces](../packages/workspaces/README.md): Workspace catalog and canonical roots.

## System capabilities

- [process-execution](../packages/process-execution/README.md): Executable process and stream lifetime.
- [file-access](../packages/file-access/README.md): Native and workspace directory access.
- [files](../packages/files/README.md): Workspace file tools and browsing.
- [shell](../packages/shell/README.md): Native command construction, timeout and output.
- [approvals](../packages/approvals/README.md): User confirmation lifecycle.
- [skills](../packages/skills/README.md): Skill discovery, loading and prompt contributions.

## UI infrastructure

- [transport](../packages/transport/README.md): HTTP registration and projection revision transport.
- [ui-gateway](../packages/ui-gateway/README.md): Browser bootstrap and change feed.
- [ui-runtime](../packages/ui-runtime/README.md): Browser Cordis graph and projection client.
- [ui-slots](../packages/ui-slots/README.md): Outlets, ordered contributions and renderer lifetimes.
- [ui-layout](../packages/ui-layout/README.md): Responsive frame, pages, tabs and dialogs.
- [ui-primitives](../packages/ui-primitives/README.md): Controls, icons and safe Markdown.
- [ui-theme](../packages/ui-theme/README.md): Visual tokens and appearance.

## Interaction features

- [conversation](../packages/conversation/README.md): Conversation controller, composer, history and navigation.
- [input](../packages/input/README.md): Message and attachment preparation.
- [file-preview](../packages/file-preview/README.md): Typed resource preview and downloads.
- [git-diff](../packages/git-diff/README.md): Workspace Git status and diffs.
- [session-helper](../packages/session-helper/README.md): Copy and revision actions.
