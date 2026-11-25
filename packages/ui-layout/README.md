# @mini-harness/ui-layout

Owns the responsive application frame, sidebar, tabs and dialogs.

## Responsibilities

Defines the page, header and right-panel contributions used by feature UI.

## Structure

`src/browser/` contains setup, layout, tabs, styles and API contracts. `src/manifest.ts` declares feature dependencies and styles.

## API

`miniPages`, `miniTabs` and `miniDialogs` own pages, tabs and dialogs.

## Dependencies

Uses [UI Slots](../ui-slots/README.md) for mounting and [UI Primitives](../ui-primitives/README.md) for controls.

## Lifecycle

`core:layout` mounts the frame and releases its listeners and styles during browser unmount.

## Testing

[Browser tests](../../test/browser/) cover navigation, panels and responsive layout.

Panel entries and tab types are registered with the caller’s Cordis lifetime. Each tab has a stable key, a workspace or conversation owner, and a typed payload; a scope change supplies a fresh access context.
