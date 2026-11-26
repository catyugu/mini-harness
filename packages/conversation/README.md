# Conversation

Composes the conversation screen, navigation, editing drafts and user-visible history. It owns browser selection and interaction state, and projects Sessions and Runs into views. Sessions owns persistent conversations, branches and attachments; Runs owns execution admission and replay.

## Native composition and configuration

The [web Profile](../../profiles/web.yml) splits this capability into Entries with independent lifetimes:

| Entry                       | Responsibility                                                                   |
| --------------------------- | -------------------------------------------------------------------------------- |
| `core:sessions-data`        | Conversation-list projection, shared selection and `harnessBrowser`.             |
| `core:conversation`         | `miniConversation`, conversation layout, approval view and server read routes.   |
| `core:composer`             | `miniComposer`, drafts and the native composer renderer.                         |
| `core:history`              | `miniMessages` and the native history renderer.                                  |
| `core:navigation`           | Conversation tree, search, rename, bulk selection, export and deletion controls. |
| `core:workspace-navigation` | Workspace picker and synchronization with workspace panels.                      |

The [conversation schema](src/manifests/conversation.ts) defines the global `messageMode` default. **Add instructions** edits this default. The composer exposes the conversation's selected delivery mode only while its Run is active. Idle messages use normal submission without an explicit delivery mode. The **Tasks** plugin contributes a removable header popover and live receipt status for background tools. It groups running and finished jobs, reading retained output only for the expanded job. The [Subagents](../subagents/README.md) plugin owns its separate child-conversation popover and parent navigation. Internal messages have collapsed, source-labeled display records; their model input remains unchanged. Delivery belongs to [Runs](../runs/README.md).

Server composition requires Sessions, Runs, Workspaces, Approvals, Routes and Changes. Browser dependencies differ by Entry; the declarations in [`manifests/`](src/manifests/) and the corresponding browser setup files are authoritative. Models supplies available model choices, Layout supplies placement, and Slots supplies replaceable outlets.

## Public browser contracts

| Import                                                                    | Service and purpose                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`mini-harness/conversation/controller`](src/browser/conversation-api.ts) | `miniConversation`: inspect and subscribe to state, activate a conversation, submit or queue input, cancel, retry, change permission and compact.       |
| [`mini-harness/conversation/composer`](src/browser/composer-api.ts)       | `miniComposer`: edit the shared draft, attach files, select a model/thinking level, submit, register commands and completions, and enter revision mode. |
| [`mini-harness/conversation/history`](src/browser/history-api.ts)         | `miniMessages`: register message actions, tool views and plugin-record renderers.                                                                       |
| [`mini-harness/conversation/navigation`](src/browser/navigation-api.ts)   | `harnessBrowser`: read the current workspace/conversation, request navigation and observe selection changes.                                            |

The composer dispatches complete registered action commands on submission after trimming surrounding whitespace, whether submitted with Enter or the Send button. Command completion and ordinary message text remain separate. Inject only the services a browser plugin uses. Registration methods returning disposers belong in `ctx.effect`; subscriptions and view callbacks accept signals. The [browser panel example](../../docs/examples/browser-panel/web.ts) contributes a message action that inserts an assistant turn into the existing draft. [Task notes](../../docs/examples/task-notes/web.ts) contributes tool and durable-record renderers.

`miniConversation.get()` exposes the current read-only view, partitioned into session, history, run, partial output, tools, queue and interaction fields. Subscribe to the fields a view actually renders. Treat returned state and composer drafts as read-only, and use the service methods to make changes.

The browser `conversation/initialize` event allows plugins to initialize a newly created session from workspace draft state. The controller awaits listeners before admitting the first Run.

## Renderer replacement and ownership

The native composer occupies key `composer` in `conversation.composer-view`; history occupies key `history` in `conversation.history`. A higher-priority contribution with the same key replaces that renderer through [UI Slots](../ui-slots/README.md). It leaves the existing controller and composer model in their owning Entries, so a renderer can unmount and return without duplicating selection, draft or execution state. Unloading those owning Entries also releases their state.

The [composer replacement example](../../docs/examples/browser-panel/web/composer.ts) uses the public contracts for this pattern. Renderers must use their supplied signal for view-specific subscriptions and work, rather than the longer-lived controller signal.

The latest Run summary, elapsed time and changed files are displayed between the scrollable history and composer. They remain visible when the history scrolls.

Navigation cancels obsolete reads and observation, not the server run. The controller reconnects run replay and reconciles authoritative history after terminal events. Display failures are reported through interaction state; a failed subscriber does not prevent other subscribers from receiving updates. Requests that admit work use the server's execution ownership, which is separate from the displayed conversation visit.

## Message and record extensions

Message actions target either one original user message or an entire assistant turn. The context supplies the original `rawText`, session ID, current branch leaf and an action lifetime signal. Use the target discriminant instead of reconstructing content from rendered DOM. Action IDs are unique and `order` controls their display.

Tool and record renderers use keyed priority selection. A higher priority wins; equal priorities for the same key conflict. Each mounted renderer receives a view signal. Returning `undefined` or throwing releases the attempted renderer's lifetime and lets the native fallback render. Plugin display records come from the selected SessionLog branch; a missing or failed record renderer falls back to the saved title. Private record changes still advance the projected branch leaf, preventing revision actions from using a stale leaf.

Server plugins can import [`mini-harness/conversation/display-events`](src/server/display-events.ts) and listen for `conversation/tool-projection`. The synchronous hook transforms a clone of a tool result for browser history or replay. Handlers resolve in the conversation's scope; a failed or invalid transformation is logged and preserves the previous projected content. This presentation hook does not modify the durable tool result or the model's context.

## Implementation and verification

[`server/routes.ts`](src/server/routes.ts) adapts session reads, search, attachments, export/deletion and run observation to HTTP. [`controller.ts`](src/browser/conversation/controller.ts) owns browser operations and replay reconciliation; [`composer-model.ts`](src/browser/conversation/composer-model.ts) owns drafts. These implementations share the public state contracts rather than coupling renderer lifetimes to execution.

[Conversation tests](../../test/browser/conversation.spec.ts), [message-action tests](../../test/browser/message-actions.spec.ts), [navigation tests](../../test/browser/navigation.spec.ts) and [rendering tests](../../test/browser/rendering.spec.ts) cover drafts, attachments, selection, actions and renderer remounting. [Record tests](../../test/plugins/records.test.ts) cover extension records and branch projections; [running tests](../../test/browser/running.spec.ts) exercise active-run interaction.

See [frontend composition](../../docs/subsystems/frontend.md), [session coordination](../../docs/subsystems/sessions.md), and the [UI component cookbook](../../docs/cookbook/adding-a-ui-component.md).
