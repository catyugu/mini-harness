# Add a settings page

Use the Entry's native Config schema as the source of truth. For ordinary plugin settings, a schema and metadata are sufficient to render configuration fields. The [greeting-service example](../examples/greeting-service/plugin.ts) demonstrates the server schema.

```ts
import { defineConfig } from 'mini-harness/configuration';

export const Config = defineConfig({
  type: 'object',
  properties: { label: { type: 'string', default: 'Notes' } },
  additionalProperties: false,
});
```

For richer UI, a browser entry injects `miniSettingsRegistry` and registers a `SettingsContribution` with the owning Entry configuration returned by `browserPluginSettings(ctx)`. Use the supplied `bind` helper to keep controls synchronized and report validation errors. The [Task notes settings implementation](../examples/task-notes/web.ts) is a working example of a bound text control.

Declare `live: true` in the Profile only when the plugin supports in-place changes. Test a valid update, an invalid update, and removal. Do not add a separate preference store for Entry configuration. See [Plugin API](../../packages/plugin-api/README.md), [Settings](../../packages/settings/README.md), and [configuration](../configuration.md).
