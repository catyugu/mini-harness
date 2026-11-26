# UI Theme

Owns the application's visual tokens and selected color scheme. Controls and feature styles consume those tokens; Theme does not own their layout or behavior.

## Configuration and activation

The [web Profile](../../profiles/web.yml) enables the native `@mini-harness/ui-theme` plugin as the live Entry `core:theme`. Its [configuration schema](src/manifest.ts) accepts `appearance: system | light | dark`, with `system` as the default. A Profile Entry can set the scheme explicitly:

```yaml
- id: core:theme
  name: '@mini-harness/ui-theme'
  live: true
  config:
    appearance: dark
```

This is an Entry fragment for the Profile's `plugins` list. See [Profiles](../../docs/profiles.md) for editing an existing Entry and layer precedence.

## Browser behavior and ownership

[`setup.ts`](src/browser/setup.ts) reads the Entry configuration, applies `data-theme` to the document root and subscribes to accepted updates. The [stylesheet](src/browser/style.css) defines the tokens and system-color-scheme behavior. There is no separate theme service or public SDK module. Tokens include semantic colors, typography, spacing, control and icon sizes, shadows and motion. Native CSS layers are ordered by the startup stylesheet; unlayered custom styles can override these defaults.

When `miniSettingsRegistry` is available, Theme contributes a selector to General and binds it to the same Entry configuration. Theme activation and changes also work without Settings. Unloading Theme releases the subscription, removes the document attribute and removes its Entry-owned stylesheet; the optional Settings contribution follows its injected lifetime.

## Typography

Use `--font-body` and `--line-body` for readable prose, `--font-ui` and `--line-ui` for controls and navigation, `--font-meta` for secondary information, `--font-caption` for timestamps and compact annotations, and `--font-code` with `--font-mono` for code. The default title scale is `--font-title`, `--font-heading`, and `--font-section`. These are shared defaults; contributed views may override them locally. Text sizing is independent of control and icon sizing.

## Verification

[Settings tests](../../test/browser/settings.spec.ts) cover live theme changes, persistence and reachable controls across viewport sizes. [File-view tests](../../test/browser/files.spec.ts) exercise themed responsive panels. See [UI Primitives](../ui-primitives/README.md) for shared controls and [Settings](../settings/README.md) for the contribution contract.
