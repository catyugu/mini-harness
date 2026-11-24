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

Consumers call `harnessScopes.prepare(scopeKey, signal)` before reading
`harnessScopes.require(scopeKey, serviceName)` or `harnessScopes.optional(scopeKey, serviceName)`. Use a full address such as `session:<id>` or `workspace:<id>`, not a bare ID. This resolves the nearest live
Cordis service, so the native agent executes through the selected LLM, tool and
environment services. Plugins declaring `inject` receive services from their own
scope's context.

The graph is validated before setup. Provider changes restart their dependent
plugins in dependency order and await cleanup. A failed configuration update restores the previously committed settings and mounts. Deleting a session or workspace removes its overrides through the same settings queue. A failed optional instance is
shown in the Plugins page, where its scope configuration can be repaired. Application replacements must replace a
multi-service plugin as a unit; scoped replacements leave the parent mounted.


The browser has its own `browserProviders` map. Select a browser service there without changing its server companion. The selected plugin declares the capability in `browserProvides` and must be enabled at application scope.

A user can grant specific registered tools to a trusted local plugin in that plugin’s Settings detail, or through `readOnlyTools` in `settings.json` or the settings API. For example, `{ "readOnlyTools": { "workspace-greeting": ["greet"] } }` allows its `greet` registration to be considered in read-only conversations when it declares read-only access. Update the map to revoke a grant. Descendant and workspace restrictions still apply before invocation.

Setup and live configuration callbacks register and update plugin resources. Scope preparation, session writes, execution submission and configuration writes are available from runtime handlers after the graph commits. Use those operations from normal runtime handlers. A prepared scoped service is a current provider reference, not a stable proxy: resolve it again after configuration changes. The browser graph is committed only when its required capabilities remain available after server mounting, including replacements.
