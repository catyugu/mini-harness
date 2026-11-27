# UI Layout

Owns the responsive application frame: navigation drawer, main page area, header, workspace panel, tabs and dialog mounting. Features contribute content through its services and slots. Conversation selection belongs to Conversation; Layout stores only presentation state and workspace-owned tabs.

## Public services and usage

Browser plugins import [`mini-harness/ui-layout`](src/browser/api.ts) and inject the services they use:

| Service       | Contract                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `miniPages`   | Register a page, contribute a page with navigation, and open a registered page or return to the conversation. |
| `miniTabs`    | Register a typed tab renderer, contribute a workspace-panel entry, and open or inspect content.               |
| `miniDialogs` | Create a mounted dialog and an explicit disposer.                                                             |
| `miniHeader`  | Set the title.                                                                                                |
| `miniLayout`  | Close the navigation drawer.                                                                                  |

The [browser panel example](../../docs/examples/browser-panel/web.ts) is a build-checked example of a page and dialog. For a workspace tab, register the type once in the plugin's lifetime and retain the returned handle:

```ts
const notes = ctx.miniTabs.register<{ text: string }>('example-notes', {
  title: () => 'Notes',
  create(data) {
    const node = document.createElement('p');
    node.textContent = data.text;
    return node;
  },
});

// workspaceId comes from the workspace being displayed.
notes.open({ owner: { workspaceId }, key: 'notes', data: { text: 'Ready' } });
```

The fragment assumes a browser plugin injecting `miniTabs` and a valid workspace ID. Use the renderer's `signal` for listeners and requests when the view needs them.

## Ownership and lifecycle

`core:layout` in the [web Profile](../../profiles/web.yml) injects `miniSlots` and `miniPrimitives` and publishes the frame services. It declares application outlets such as `sidebar.actions`, `header.actions`, `conversation.body` and `dialog.root`; see the [slot declarations](src/browser/api.ts) for names and cardinality. The header reserves two stable rows. `header.context` contains flexible context and navigation content; `header.actions` contains independent action contributions. Both accept arbitrary DOM nodes; contributors own their visibility. Layout moves the trailing contributions into a native ellipsis popover when the row runs out of space, preserving their mounted instances and restoring them inline as space returns.

Page IDs are unique. `miniPages.register` and `contribute` return disposers; register them with `ctx.effect`. Removing the selected page returns to the conversation. A dialog is mounted at creation, opened with its element's `showModal()`, and released with its returned disposer.

Tab types and panel entries automatically belong to the calling Cordis fiber. A tab is identified by its registered type, workspace owner and stable key. Opening that identity again selects the existing tab rather than replacing its payload. Optional `signal` gives a tab a shorter lifetime. Closing a tab, unloading its provider or pruning its workspace aborts the view's signal and removes the view.

Tabs survive conversation switches. Switching workspaces detaches their views and retains the workspace's tab selection, panel state and scroll position for a return visit. This state is in browser memory, not durable session storage. A failing tab renderer displays its error after aborting that attempted view's lifetime.

On desktop, the navigation sidebar starts at 340 CSS pixels and can be resized from 280 to 380 pixels by dragging its inner edge or using the arrow keys on the focused separator. The browser remembers the selected width, including across reloads and collapse/expand. The sidebar width and collapse state are controlled by the user. Layout reduces the workspace panel's displayed width to reserve space for the main area, then switches it to a modal drawer if the three regions no longer fit. The panel retains its selected width and mounted tabs as space returns. On mobile the navigation remains an overlay drawer without a resize handle.

Layout has no plugin configuration. [`layout-state.ts`](src/browser/layout-state.ts) owns desktop geometry and resolves the pure layout projection; the 520px budget applies only to right-panel docking. [`layout.ts`](src/browser/layout.ts) owns preferences and interaction state, projects the initial frame before insertion, and manages DOM and focus effects. Resizing the window never writes back to preferences. [`right-tabs.ts`](src/browser/right-tabs.ts) remembers the panel's visibility only at workspace boundaries; the active panel is controlled by Layout.

## Verification

[File-view tests](../../test/browser/files.spec.ts) cover tabs, responsive panels and viewport constraints; [navigation tests](../../test/browser/navigation.spec.ts) and [plugin tests](../../test/browser/plugins.spec.ts) exercise contributions and cleanup. See [UI Slots](../ui-slots/README.md) for replacement semantics and [frontend composition](../../docs/subsystems/frontend.md) for shared view state.
