# Session Helper

Session Helper contributes copy and edit/resend actions to conversation messages. It owns those browser actions and the revision draft it opens. [Conversation](../conversation/README.md) owns shared message and composer state; [Sessions](../sessions/README.md) validates branch identity, and [Runs](../runs/README.md) admits the replacement run.

## Usage and contributions

The Web Profile enables the `session-helper` entry. Toggle it in Plugins to add or remove its actions. It has no Config schema, server service or standalone SDK export.

- **Copy message** copies the action target's raw text through the browser clipboard API. The target is an original user message or a complete assistant turn, as defined by Conversation.
- **Edit message** is available for a persisted user message with a known current leaf. It opens a composer draft containing the original text and attachments and records `sourceEntryId` and `expectedLeafId`.

Editing submits a new branch through the normal conversation workflow. It does not overwrite the original message or delete other branches. The expected leaf prevents a stale editor from silently revising a branch that has moved.

## Attachment and lifetime behavior

[setup.ts](src/browser/setup.ts) restores images from the message's retained image data and retrieves other original uploads by their stored attachment IDs. If an older text-file attachment lacks a stored ID, the draft explicitly asks the user to reattach it. Network failures propagate through the action workflow instead of silently dropping an available upload.

The native browser entry injects `miniMessages` and `miniComposer`. Action registration and the draft-mode disposer belong to the plugin's Cordis effects; unloading the plugin releases its editing draft. Attachment requests carry the action's cancellation signal, and a cancelled action does not open a late draft.

Plugins can add their own actions through `mini-harness/conversation/history` and draft modes through `mini-harness/conversation/composer`. The owning [Conversation README](../conversation/README.md) defines those contracts. Revision validation and run submission stay in the server owners rather than being duplicated in this UI helper.

## Testing

[Revision tests](../../test/system/revision.test.ts) cover selected-branch replacement, rejected input, retained history and stale-leaf conflicts. [Message-action browser tests](../../test/browser/message-actions.spec.ts) cover copy, attachment restoration and draft cleanup. See [session coordination](../../docs/subsystems/sessions.md) for the revision flow.
