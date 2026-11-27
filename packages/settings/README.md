# Settings

Provides the Settings dialog, contribution registry and HTTP view of the active Profile configuration. The Profile configuration service owns committed values, validation and reconciliation; Settings displays that state and forwards edits to its owner.

## Activation and public API

The [web Profile](../../profiles/web.yml) enables `@mini-harness/ui-settings` as `core:settings`. Its server half injects `harnessProfileConfig`, `harnessRoutes` and `harnessChanges`. Its browser half injects `miniLayout`, `miniSlots` and `miniProjections`.

Browser plugins import [`mini-harness/ui-settings`](src/browser/api.ts):

| Service                | Contract                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `miniSettings`         | Open the dialog by section ID and observe closure.                                     |
| `miniSettingsRegistry` | Define sections and register controls or plugin-detail renderers.                      |
| `miniSettingsData`     | Read and subscribe to the browser's projection of the committed Profile configuration. |

`GET /api/settings` reads the committed configuration; `PATCH /api/settings` delegates an update to `harnessProfileConfig`. Per-plugin configuration routes and the plugin catalog belong to [Plugins](../plugins/README.md). Settings itself has no configuration schema.

## Contributing controls

Use `miniSettingsRegistry.register(owner, contribution, configuration)` inside a Cordis effect. `owner` is the browser Entry ID from `browserPluginId(ctx)`; `configuration` normally comes from `browserPluginSettings(ctx)`. The [Task notes example](../../docs/examples/task-notes/web.ts) is a complete, build-checked contribution, and the [settings cookbook](../../docs/cookbook/adding-a-settings-page.md) explains its setup.

Define a page with `registerSection({ id, title, icon, order }, signal)`. The defining Entry owns that ID and its navigation metadata for the given lifetime. Its returned updater can change the label, icon or order while preserving the section's identity and mounted controls. Settings defines `general`.

Contributions reference `sectionId`, have their own owner-local ID, and optionally specify an order within the section. The registry shows a section when its definition and at least one contribution are present. Definitions and contributions can arrive in either order.

The renderer receives a `SettingsContext` with its own `signal`, `configuration`, and `bind`. `bind(control, key, { read, write })` initializes the control, subscribes to accepted updates and writes changes through the configuration owner. Append its returned element to show inline failures. While a write is pending it disables the control; on completion it rereads the accepted value, so rejected edits do not become a separate local setting.

Use `ctx.effect(() => miniSettingsRegistry.registerPlugin(browserPluginId(ctx), render))` to own the configuration area on the Entry's Plugins page. The renderer receives the view's abort signal and returns the whole configuration area. It owns the controls, layout and save interaction. Declare styles in the plugin's browser metadata and use `browserPluginSettings(ctx)` for validated writes. The [Subagents configuration view](../subagents/src/browser/configuration.ts) is an example.

## Lifetime and configuration ownership

Normal section renderers live until their contribution is removed, including while the dialog is closed. Their signal aborts on removal or a failed initial render. Plugin-detail renderers have shorter lifetimes tied to the displayed detail and are aborted when that view closes or their registration disappears. Attach requests and subscriptions to the signal appropriate to the displayed content.

The browser data store is a projection, not another configuration owner. Entry identity, enablement, live updates, scoped composition and persistence are governed by [Profiles](../../docs/profiles.md). Unloading Settings removes its routes, projections, controls and dialog contributions.

## Verification

[Configuration tests](../plugin-api/tests/selection.test.ts) cover bounds and preservation of unrelated sections. [Plugin lifecycle tests](../../test/plugins/lifecycle.test.ts) cover reconciliation and rollback; [Settings browser tests](../../test/browser/settings.spec.ts) cover live updates, persistence and responsive navigation.
