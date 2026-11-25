# Scoped provider selection

The application selects providers through the top-level `providers` map.
A workspace or session may select a local replacement through its
`scopes[scopeKey].providers` map. Without a local choice, the scope inherits
the nearest parent's services.

Example:

```json
{
  "scopes": {
    "workspace:0123456789abcdef0123456789abcdef": {
      "plugins": { "workspace-greeting": true },
      "providers": { "exampleGreeting": "workspace-greeting" }
    }
  }
}
```

A local replacement must be enabled at that address. Host infrastructure
(scope resolution, configuration, authenticated routes and mutation control)
cannot be overridden. The tool registry and inherited authorization policy are protected because they enforce the final restrictions on model calls. Feature services, including the model adapter, can be replaced through their declared contracts. The default composition checks for required capabilities after mounting the chosen providers. An inherited multi-service provider
continues supplying its other services when a child replaces just one of them.

Provider selection and isolation follow application → workspace → ancestor
session → session. A choice affects only its subtree. A sibling keeps its
parent's provider. Remove the local provider selection to restore inheritance.
New or changed required provider selections must mount successfully before settings are committed. A previously saved provider that fails during startup or lazy preparation remains unavailable in its subtree until repaired. A second instance of the same provider ID needs an explicit choice to
shadow its ancestor.

Plugins declare required services in their Cordis `inject` declaration. A running
plugin can use `await sessionService(ctx, sessionId, name, signal)` to access a declared service in a visible session. The native
agent uses the selected LLM, tools, and environment through the session context.

Cordis deactivates consumers when a required provider leaves and activates them
with the new service. A failed settings update restores the committed entries.
Deleting a session or workspace releases its entries and removes its overrides.
Optional instance failures are shown in Plugins and can be repaired there.

Browser services use Cordis dependency injection directly. Enable the browser modules that supply the desired services.

A user can grant specific registered tools to a trusted local plugin in that plugin’s Settings detail, or through `readOnlyTools` in `settings.json` or the settings API. For example, `{ "readOnlyTools": { "workspace-greeting": ["greet"] } }` allows its `greet` registration to be considered in read-only conversations when it declares read-only access. Update the map to revoke a grant. Descendant and workspace restrictions still apply before invocation.

Setup and live configuration callbacks register and update plugin resources. Scope preparation, session writes, execution submission and configuration writes are available from runtime handlers after the configuration commits. Use those operations from normal runtime handlers. A prepared scoped service is a current provider reference, not a stable proxy: resolve it again after configuration changes. Browser entries are published for active server entries; the browser resolves its own dependencies through Cordis.

Provider selections and scoped plugin configuration are written to the active [Profile](profiles.md). Tool grants and scoped tool restrictions are saved as domain settings.
