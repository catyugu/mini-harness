# Application composition

[Host](../../packages/host/README.md) resolves a named Profile, reads its ordered layers and supplies launch paths. The [Profile reference](../profiles.md) owns the layer syntax and initialization rules. [Plugins](../../packages/plugins/README.md) resolves native modules and browser assets and binds configured resource scopes. [Cordis](../cordis.md) owns activation, injection and effects.

1. The launcher acquires the configuration-directory instance lock and starts the Profile's Entry Tree.
2. Declared modules resolve through the same loader contract whether shipped, local, or npm dependencies. Disabled entries are not imported.
3. Cordis activates consumers when required services exist. The Web listener, transport and gateway are ordinary configured services.
4. Workspace/session owners expose runtime identity and ancestry. Plugins mount configured compositions, with explicit service isolation and normal dependency lifetimes. See [scoped providers](../scoped-providers.md) for the persistent-address and runtime-key contracts.
5. Configuration edits are serialized by the Profile composition owner. A candidate is reconciled before persistence; rejection restores the prior entries. Settings forwards edits, not a second configuration store.
6. The browser loads its separate Entry Tree from published assets. Disposing a plugin releases its own registrations and resources; shutting down the Profile drains outstanding work.

For a plugin's own configuration use its Entry's native schema, not a second settings model. For a resource's state use its domain service. Plugin-owned data and credentials are distinct from Profile composition.

See [configuration](../configuration.md), [plugin packaging](../plugins.md) and the [creation cookbook](../cookbook/creating-a-plugin.md).
