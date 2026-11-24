# @mini-harness/conversation

Composes the conversation screen, session navigation, and user-visible history and run replay.

## Responsibilities

Owns session and workspace selection, the transcript, search, composer and message actions. Reads session history and run activity through the respective capability APIs.

## Structure

`src/manifests/` declares conversation, session data, navigation and workspace controls. `src/server/` aggregates read models and adapts run events. `src/shared/` contains HTTP response contracts. `src/browser/` renders the conversation and navigation.

## API

`conversationExtensions` registers composer commands, completions and message actions. `sessionDisplayExtensions` transforms tool output sent to the browser. `harnessBrowser` exposes selection to plugins.

## Dependencies

Reads [Sessions](../sessions/README.md), [Runs](../runs/README.md), [Models](../models/README.md), [Workspaces](../workspaces/README.md) and [Approvals](../approvals/README.md). Uses layout and slot APIs to mount UI.

## Lifecycle

Application browser plugins `core:conversation`, `core:sessions-data`, `core:navigation` and `core:workspace-navigation` own their requests, contributions and event listeners. Display hooks leave the durable log and the model context intact.

## Configuration

`core:conversation.queueMode` defaults to `steer` in the manifest and can be updated in Settings.

The native composer and message history occupy keyed outlets. Plugin display records project from the active log branch with a title fallback when the browser renderer is absent.

## Testing

[Browser conversation and navigation suites](../../test/browser/) cover rendering, search, image previews, message actions and stream reconnection.
