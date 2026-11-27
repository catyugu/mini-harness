# Plugins

Plugins resolves explicit Profile entries, coordinates their Cordis compositions, and publishes the catalog and browser assets. It implements scoped configuration, plugin-private storage and the plugin manager. [Host](../host/README.md) owns the Profile files; [Cordis](../../docs/cordis.md) owns service activation and Fiber lifetime.

## Activation and services

The shipped base Profile mounts `core:plugins-runtime` as `@mini-harness/plugins-runtime`. The Web Profile separately mounts the management interface. External modules enter the same native Cordis path through a Profile entry:

```yaml
plugins:
  - id: greeting
    name: ./plugins/greeting/plugin.js
```

The path is relative to the YAML that declares it. Installing a package or copying files into a directory does not activate a plugin. Follow [plugin development](../../docs/plugins.md) for supported module exports, metadata and browser output, and [Profiles](../../docs/profiles.md) for activation and npm commands.

The runtime provides:

| Service                                     | Responsibility                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `harnessProfileConfig`                      | Serialized configuration updates, committed state subscriptions and removal of deleted resource scopes. |
| `harnessProfileScopes`                      | Resource-address resolution, prepared scoped compositions and their Contexts.                           |
| `harnessPluginCatalog`                      | Metadata, diagnostics, browser bootstrap entries and declared browser assets.                           |
| `harnessPluginSettings`                     | The calling Entry's validated configuration handle.                                                     |
| `harnessPluginData`, `harnessPluginSecrets` | Private data and credentials bound to the calling Entry and scope.                                      |
| `harnessPluginChanges`                      | Publication requests for the calling plugin's data.                                                     |

The public service types come from [Plugin API](../plugin-api/README.md). `PluginHost`, catalog classes and the internal runtime entry are implementation details, not external SDK constructors.

## Configuration transactions and scopes

[manager.ts](src/server/manager.ts) serializes updates. It builds and validates the candidate descriptors, reconciles the server and configured child graphs, prepares browser publication, then asks the Profile owner to persist the accepted result. A rejected update restores the previous entries; a restoration failure is reported together with the original error. Listeners observe committed changes. `harnessProfileConfig.stable` is false during initial activation, reconciliation, failed restoration and shutdown. The separate `profile/graph-settled` event follows initial activation, a successful update or a successful rollback, after committed-settings listeners have run. Derived domains can recompute against this boundary without interpreting configuration commits as graph lifecycle events.

Configuration writes during plugin setup and reentrant updates during graph reconciliation are rejected. The runtime cannot replace its own active transaction owner through that transaction. Loaded entries receive `internal/update`; the default behavior restarts non-live entries and accepts live entries in place. A listener can handle an update or reject a change that requires a Profile restart.

Domain owners register resource resolvers. The Web catalog edits top-level Profile entries. The Plugins page lists local plugins and built-ins that provide a configuration view. Each plugin can register its own controls and styles through [Settings](../settings/README.md#contributing-controls), or opt in to a form generated from its schema by declaring `configForm: {}` in its metadata. A static `configSchema` can supply the form before the server module loads. Settings → Built-in plugins lists bundled entries and uses switches for optional (non-`core:`) entries. Configure scoped composition through Profile YAML. See [Scoped providers](../../docs/scoped-providers.md) for the hierarchy and replacement rules.

## Private data and browser publication

[Data services](src/server/data.ts) derive their namespace from the calling Entry ID and its persistent scope address. Data reads return the supplied fallback when absent; JSON writes replace the file atomically. Secret values use private files and Windows CurrentUser protection on Windows. Keep credentials in `harnessPluginSecrets`: effective plugin configuration can be published to the browser. Forgetting a deleted resource's scope removes its scoped plugin data after graph reconciliation.

[Descriptor resolution](src/server/descriptor.ts) combines optional static metadata with native module metadata and schemas. Declared `mini-harness` peer ranges are checked. Disabled entries can be listed without importing their executable module.

[Browser publication](src/server/browser-assets.ts) exposes declared build resources under versioned URLs. The browser receives its own Cordis entry graph and serializable effective configuration; it does not share server Contexts or objects. Disabling or replacing an entry disposes its server and browser registrations through their respective owners. A package's `/client` export can be activated as a separate browser entry.

## Testing and related documentation

[Composition](../../test/plugins/composition.test.ts), [installation](../../test/plugins/installation.test.ts), [lifecycle](../../test/plugins/lifecycle.test.ts) and [extensions](../../test/plugins/extensions.test.ts) tests cover native loading, scoped providers, private services, browser publication and cleanup. [Live-settings tests](../../test/system/live-settings.test.ts) cover transaction acceptance and rollback.

See [composition](../../docs/subsystems/composition.md) for the startup sequence, [frontend](../../docs/subsystems/frontend.md) for browser graph ownership, and the [Task notes example](../../docs/examples/task-notes/README.md) for a complete external consumer.
