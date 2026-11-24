# @mini-harness/conversation

Composes the conversation screen, session navigation, and user-visible history and run replay.

## Responsibilities

Owns session and workspace selection, the transcript, search, composer and message actions. Reads session history and run activity through the respective capability APIs.

## Structure

`src/manifests/` declares conversation, session data, navigation and workspace controls. `src/server/` aggregates read models and adapts run events. `src/shared/` contains HTTP response contracts. `src/browser/` contains a DOM-independent conversation controller, composer model and renderer, history renderer, layout and navigation.

## API

`miniComposer` registers commands and completions. `miniMessages` registers message actions and renderers. `conversation/tool-projection` transforms tool output sent to the browser. `harnessBrowser` exposes selection to plugins. `miniConversation` exposes selected history and live run state through field subscriptions. `miniComposer` owns drafts and the shared editing, attachment, model, permission and submission contract.

## Dependencies

Reads [Sessions](../sessions/README.md), [Runs](../runs/README.md), [Models](../models/README.md), [Workspaces](../workspaces/README.md) and [Approvals](../approvals/README.md). Uses layout and slot APIs to mount UI.

## Lifecycle

Application browser plugins `core:conversation`, `core:composer`, `core:history`, `core:sessions-data`, `core:navigation` and `core:workspace-navigation` own their requests, contributions and event listeners. Display hooks leave the durable log and the model context intact.

## Configuration

`core:conversation.queueMode` defaults to `steer` in the manifest and can be updated in Settings.

The native composer and message history occupy keyed outlets. Replacing a renderer disposes its resources without discarding shared controller state; removing a replacement restores the previous renderer. Plugin display records project from the active log branch. Record updates carry the branch leaf identity, including private records. Each record renderer owns a separate lifetime and releases resources immediately on failure before displaying the saved title as a fallback.

## Testing

[Browser conversation and navigation suites](../../test/browser/) cover rendering, search, image previews, message actions and stream reconnection.
