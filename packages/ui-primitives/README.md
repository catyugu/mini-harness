# UI Primitives

Provides shared browser controls, icons and the internal Markdown renderer used by feature views. It owns presentation helpers and their base styles. Layout owns placement, Theme owns visual tokens, and each caller owns the state and event handlers of its controls.

## Using shared controls

Browser plugins import [`BrowserPrimitives` from `mini-harness/ui-primitives`](src/browser/api.ts) and inject `miniPrimitives`. The service creates buttons, labelled fields, dialogs, status messages, menus and icons. For example, inside a plugin's `apply(ctx)`:

```ts
const input = document.createElement('input');
const field = ctx.miniPrimitives.field('Label', input);
const save = ctx.miniPrimitives.button('Save', 'primary');
field.append(save);
```

Mount the returned nodes through a page, dialog or slot contribution and attach listeners with that view's signal. Creating a primitive does not register or persist it. The [browser panel example](../../docs/examples/browser-panel/web.ts) demonstrates controls together with Layout, Settings and message actions.

`icon` accepts a symbolic icon name or a custom SVG path specification. The [API source](src/browser/api.ts) defines the supported control variants; the [icon implementation](src/browser/icons.ts) owns the icon vocabulary.

## Optional layout and styling

Use `ui-row`, `ui-stack`, `ui-fill`, `ui-fixed`, `ui-truncate`, `ui-scroll` and `ui-content-width` on any native elements. Row and stack spacing is configurable with `--gap`; list rows also accept `--row-size`. `ui-meta`, `ui-status-dot` (with semantic `data-tone`), `ui-disclosure` and `ui-popover` provide shared presentation without prescribing content or business state. Custom components and unlayered plugin styles remain supported.

Use `bindPopover(trigger, panel, signal, options)` for a native popover. The returned positioning function can be called immediately after opening; the binding tracks viewport changes and updates the trigger's expanded state. `positionFloating` also works with an already visible non-popover surface.

The internal `textOutput` and `rasterImage` helpers create bounded plain-text and raster-image views. Their callers own the content, composition and any additional styling.

## Markdown and lifecycle

The internal [`renderMarkdown`](src/browser/markdown.ts) helper parses with the pinned Marked distribution and sanitizes the result with DOMPurify. It allows a defined subset of elements and attributes, removes arbitrary classes, gives external links safe new-window attributes, and wraps tables for horizontal scrolling. Interactive rendering adds copy controls to code blocks. Streaming and completed Markdown use the same parser, sanitization and layout. The helper compares normalized sanitized blocks before decoration, retains unchanged DOM (including code controls and table scrolling), and replaces changed blocks only. Full parsing still handles later input that changes earlier Markdown semantics. Callers supply the original accumulated text without repairing incomplete syntax; `markdownSource` associates the rendered node with that unmodified source. This helper is used by native views; it is not a method of the public `miniPrimitives` service or a separate SDK export.

The `core:primitives` browser Entry is enabled by the [web Profile](../../profiles/web.yml). Its MutationObserver hydrates icons in newly contributed DOM and disconnects on unload. Its stylesheet follows the browser Entry lifetime. It has no configuration or server service, and does not require Settings to render controls.

## Verification

[Rendering tests](../../test/browser/rendering.spec.ts) exercise Markdown, unsafe input and tool output. [File-view tests](../../test/browser/files.spec.ts) cover the shared controls in responsive panels. See [UI Theme](../ui-theme/README.md), [UI Layout](../ui-layout/README.md), and the [UI component cookbook](../../docs/cookbook/adding-a-ui-component.md).
