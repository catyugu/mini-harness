# @mini-harness/ui-layout

Owns the responsive application frame, sidebar, tabs and dialogs.

## Responsibilities

Defines the page, header and right-panel contributions used by feature UI.

## Structure

`src/browser/` contains setup, layout, tabs, styles and API contracts. `src/manifest.ts` declares feature dependencies and styles.

## API

`layoutExtensions` and its page and tab contracts are exported through the browser SDK.

## Dependencies

Uses [UI Slots](../ui-slots/README.md) for mounting and [UI Primitives](../ui-primitives/README.md) for controls.

## Lifecycle

`core:layout` mounts the frame and releases its listeners and styles during browser unmount.

## Testing

[Browser tests](../../test/browser/) cover navigation, panels and responsive layout.
