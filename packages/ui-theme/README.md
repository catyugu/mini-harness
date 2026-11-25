# @mini-harness/ui-theme

Owns visual tokens and applies the selected browser color scheme.

## Responsibilities

Publishes theme variables and contributes its own appearance controls when Settings is installed.

## Structure

`src/manifest.ts` declares appearance defaults and the stylesheet. `src/browser/` applies theme changes.

## API

Appearance uses the theme Entry's native configuration and the Settings contribution API.

## Dependencies

[UI Primitives](../ui-primitives/README.md) and [UI Layout](../ui-layout/README.md) consume these tokens.

## Lifecycle

The theme applies independently of Settings. Its selected scheme and stylesheet are released at browser unmount.

## Configuration

`core:theme.appearance` defaults to `system`. Settings can switch to light or dark live.

## Testing

[Settings browser tests](../../test/browser/settings.spec.ts) cover live theme changes.
