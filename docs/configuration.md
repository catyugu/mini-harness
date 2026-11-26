# Configuration map

The application uses `~/.mini-harness` (or `MINI_HARNESS_HOME`) for private runtime data. Do not treat all files in this directory as interchangeable settings.

| Concern                                                         | Owner and reference                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Launch options, Profile selection, YAML layers and CLI overlays | [Profiles](profiles.md)                                             |
| Plugin activation, configuration schema and browser assets      | [Plugins](../packages/plugins/README.md)                            |
| Runtime scope identities and scoped service replacement         | [Scoped providers](scoped-providers.md)                             |
| Settings UI and configuration contributions                     | [Settings](../packages/settings/README.md)                          |
| Provider definitions, credentials, model preference             | [Models](../packages/models/README.md)                              |
| Workspace roots                                                 | [Workspaces](../packages/workspaces/README.md)                      |
| Conversation permissions, records and attachments               | [Sessions](../packages/sessions/README.md)                          |
| Shell and isolation                                             | [Shell](../packages/shell/README.md) and [security](../SECURITY.md) |

The built-in [base](../profiles/base.yml) and [Web](../profiles/web.yml) bundles declare the shipped entries. A plugin's native Config schema supplies its actual defaults and validation; read the owning package for semantics. Entry activation and settings updates are coordinated by the Profile, not by independent feature-specific settings files.

For UI workflows see [daily use](user/getting-started.md). For authoring a configuration schema and settings controls see the [settings cookbook](cookbook/adding-a-settings-page.md).
