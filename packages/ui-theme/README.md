# @mini-harness/ui-theme

Owns visual tokens and applies the selected browser color scheme.

## Responsibilities

Publishes theme variables and the appearance configuration consumed by the Settings dialog.

## Structure

`src/manifest.ts` declares appearance defaults and the stylesheet. `src/browser/` applies theme changes.

## API

`miniAppearance` supplies the theme plugin configuration to Settings.

## Dependencies

[UI Primitives](../ui-primitives/README.md) and [UI Layout](../ui-layout/README.md) consume these tokens.

## Lifecycle

`core:theme` loads before foundational controls. Its selected scheme and stylesheet are released at browser unmount.

## Configuration

`core:theme.appearance` defaults to `system`. Settings can switch to light or dark live.

## Testing

[Settings browser tests](../../test/browser/settings.spec.ts) cover live theme changes.
