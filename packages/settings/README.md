# Settings

Provides the Settings dialog, contribution registry and HTTP view of the active Profile configuration. The Profile configuration service owns committed values, validation and reconciliation; Settings displays that state and forwards edits to its owner.

## Activation and public API

The [web Profile](../../profiles/web.yml) enables `@mini-harness/ui-settings` as `core:settings`. Its server half injects `harnessProfileConfig`, `harnessRoutes` and `harnessChanges`. Its browser half injects `miniLayout`, `miniSlots` and `miniProjections`.

Browser plugins import [`mini-harness/ui-settings`](src/browser/api.ts):

| Service                | Contract                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `miniSettings`         | Open the dialog, optionally at a section, and observe closure.                         |
| `miniSettingsRegistry` | Register a section contribution or plugin-detail renderer, and mount plugin details.   |
| `miniSettingsData`     | Read and subscribe to the browser's projection of the committed Profile configuration. |

`GET /api/settings` reads the committed configuration; `PATCH /api/settings` delegates an update to `harnessProfileConfig`. Per-plugin configuration routes and generated plugin forms belong to [Plugins](../plugins/README.md). Settings itself has no configuration schema.

## Contributing controls

Use `miniSettingsRegistry.register(owner, contribution, configuration)` inside a Cordis effect. `owner` is the browser Entry ID from `browserPluginId(ctx)`; `configuration` normally comes from `browserPluginSettings(ctx)`. The [Task notes example](../../docs/examples/task-notes/web.ts) is a complete, build-checked contribution, and the [settings cookbook](../../docs/cookbook/adding-a-settings-page.md) explains its setup.

A contribution has an ID unique within its owner, a section title or section description, optional order, and a renderer. Sections with the same title share one page; section order controls navigation and contribution order controls content placement. Registration rejects invalid IDs, duplicate owner/ID pairs and non-finite order values.

The renderer receives a `SettingsContext` with its own `signal`, `configuration`, and `bind`. `bind(control, key, { read, write })` initializes the control, subscribes to accepted updates and writes changes through the configuration owner. Append its returned element to show inline failures. While a write is pending it disables the control; on completion it rereads the accepted value, so rejected edits do not become a separate local setting.

`registerPlugin` supplies additional content for a selected plugin's detail view. Its renderer may decline a plugin by returning `undefined`. The `settings/options` event supplies dynamic choices for schema-driven fields; see the [public event type](src/browser/api.ts) and [Plugins' form implementation](../plugins/src/browser/fields.ts).

## Lifetime and configuration ownership

Normal section renderers live until their contribution is removed, including while the dialog is closed. Their signal aborts on removal or a failed initial render. Plugin-detail renderers have shorter lifetimes tied to the displayed detail and are aborted when that view closes or their registration disappears. Attach requests and subscriptions to the signal appropriate to the displayed content.

The browser data store is a projection, not another configuration owner. Entry identity, enablement, live updates, scoped composition and persistence are governed by [Profiles](../../docs/profiles.md). Unloading Settings removes its routes, projections, controls and dialog contributions.

## Verification

[Configuration tests](../plugin-api/tests/selection.test.ts) cover bounds and preservation of unrelated sections. [Plugin lifecycle tests](../../test/plugins/lifecycle.test.ts) cover reconciliation and rollback; [Settings browser tests](../../test/browser/settings.spec.ts) cover live updates, persistence and responsive navigation.
