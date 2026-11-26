# Package index

These private source packages are built into a single npm package. Locate the owning capability here before changing behavior. The categories are navigation, not package namespaces or an import graph. For the global dependency direction see [architecture](../docs/architecture.md); installed imports are defined in [root exports](../package.json).

## Composition and platform

- [host](host/README.md): Profile loading, launch and process lifecycle.
- [plugin-api](plugin-api/README.md): Shared plugin, configuration and scope contracts.
- [plugins](plugins/README.md): Module resolution, scope composition and browser asset publication.
- [settings](settings/README.md): Configuration editing and settings contributions.
- [platform](platform/README.md): Generic OS, path, JSON and secret-storage helpers.

## Execution

- [tasks](tasks/README.md): Business-independent async scheduling and task handles.
- [agent](agent/README.md): Native model-turn loop, prompts and compaction.
- [runs](runs/README.md): Conversation run submission and replay.
- [llm](llm/README.md): Native model protocol and adapter selection.
- [models](models/README.md): Model catalog, provider data and model preference.
- [tools](tools/README.md): Tool registration and invocation.
- [subagents](subagents/README.md): Child conversation delegation policy.

## Data and identity

- [sessions](sessions/README.md): Conversation identity, history, attachments and deletion.
- [workspaces](workspaces/README.md): Workspace catalog and canonical roots.

## System capabilities

- [process-execution](process-execution/README.md): Executable process and stream lifetime.
- [sandbox](sandbox/README.md): Command isolation preparation.
- [file-access](file-access/README.md): Native and confined directory access.
- [files](files/README.md): Workspace file tools and browsing.
- [shell](shell/README.md): Shell tool, approval coordination and output.
- [approvals](approvals/README.md): User confirmation lifecycle.
- [skills](skills/README.md): Skill discovery, loading and prompt contributions.

## UI infrastructure

- [transport](transport/README.md): HTTP registration and projection revision transport.
- [ui-gateway](ui-gateway/README.md): Browser bootstrap and change feed.
- [ui-runtime](ui-runtime/README.md): Browser Cordis graph and projection client.
- [ui-slots](ui-slots/README.md): Outlets, ordered contributions and renderer lifetimes.
- [ui-layout](ui-layout/README.md): Responsive frame, pages, tabs and dialogs.
- [ui-primitives](ui-primitives/README.md): Controls, icons and safe Markdown.
- [ui-theme](ui-theme/README.md): Visual tokens and appearance.

## Interaction features

- [conversation](conversation/README.md): Conversation controller, composer, history and navigation.
- [input](input/README.md): Message and attachment preparation.
- [file-preview](file-preview/README.md): Typed resource preview and downloads.
- [git-diff](git-diff/README.md): Workspace Git status and diffs.
- [session-helper](session-helper/README.md): Copy and revision actions.
