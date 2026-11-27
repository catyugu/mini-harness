# Add plugin settings

Use the native Entry Config schema as the source of truth. Register a plugin-owned browser configuration view with `miniSettingsRegistry.registerPlugin(browserPluginId(ctx), render)` for the Plugins page, or contribute controls to a Settings section. The renderer owns all controls, layout and save behavior; the schema validates writes.

## 1. Define and validate configuration

The [Greeting service](../examples/greeting-service/plugin.ts) defines a prefix with `defineConfig` from `mini-harness/configuration`. [Task notes](../examples/task-notes/plugin.ts) adds a label with a default and a refinement that rejects blank strings. Native schema validation supplies the effective config before activation.

For a non-live plugin, read the validated `config` argument in `apply`. For a live plugin, read the current Entry configuration or react to the native update event; do not capture a stale initial value. Task notes reads `harnessPluginSettings.get('label')` when it needs the current label. See [Plugin API](../../packages/plugin-api/README.md) for configuration contracts.

## 2. Bind a custom control

The [Task notes browser entry](../examples/task-notes/web.ts) injects `miniSettingsRegistry` and `miniPrimitives`. It obtains its identity with `browserPluginId(ctx)` and its Entry configuration with `browserPluginSettings(ctx)` from `mini-harness/ui-runtime/plugin-settings`.

Define a section with `registerSection` for your browser Entry lifetime or use an existing section ID such as `general`. Register a `SettingsContribution` with that `sectionId` and the Entry configuration inside `ctx.effect`. The contribution's `render({ bind })` creates a labeled input and binds it to `label`. The returned error element displays failed validation, and the supplied lifecycle keeps the control synchronized until the view is removed. Use primitives for controls and field layout, and the render context's signal for additional listeners.

## 3. Enable and verify the example

Build and activate [Task notes](../examples/task-notes/README.md). Its Profile entry declares `client: true` and `live: true`. Open Settings → Task notes and change **Task note label**. New notes should use the accepted value without restarting the plugin. Enter a blank label: validation should reject it, show an error and retain the prior accepted config. Reload the application and confirm the accepted value persists; disable the plugin and confirm its settings contribution disappears.

The Profile composition path reconciles changes before the Host persists its user layer. A settings renderer does not own another preference file. Store service credentials with `harnessPluginSecrets`; browser entries receive their config, so secrets do not belong in those fields.

[Settings](../../packages/settings/README.md) documents registration and binding lifetimes. [Profiles](../profiles.md) owns layer precedence and `live` declarations; [live-settings tests](../../test/system/live-settings.test.ts) cover update behavior.
