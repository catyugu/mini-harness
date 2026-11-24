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
cannot be overridden. Feature services, including the model adapter, can be
replaced through their declared contracts. An inherited multi-service provider
continues supplying its other services when a child replaces just one of them.

Provider selection and isolation follow application → workspace → ancestor
session → session. A choice affects only its subtree. A sibling keeps its
parent's provider. Remove the local provider selection to restore inheritance.
A selected provider that fails to mount remains unavailable in its subtree until
repaired. A second instance of the same provider ID needs an explicit choice to
shadow its ancestor.

Consumers call `harnessScopes.prepare(sessionId, signal)` before reading
`harnessScopes.require(sessionId, serviceName)` or `harnessScopes.optional(sessionId, serviceName)`. This resolves the nearest live
Cordis service, so the native agent executes through the selected LLM, tool and
environment services. Plugins declaring `inject` receive services from their own
scope's context.

The graph is validated before setup. Provider changes restart their dependent
plugins in dependency order and await cleanup. A failed configuration update restores the previously committed settings and mounts. Deleting a session or workspace removes its overrides through the same settings queue. A failed optional instance is
shown in the Plugins page, where its scope configuration can be repaired. Application replacements must replace a
multi-service plugin as a unit; scoped replacements leave the parent mounted.


The browser has its own `browserProviders` map. Select a browser service there without changing its server companion. The selected plugin declares the capability in `browserProvides` and must be enabled at application scope.

A user can grant specific registered tools to a trusted local plugin through `readOnlyTools` in `settings.json` or the settings API. For example, `{ "readOnlyTools": { "workspace-greeting": ["greet"] } }` allows its `greet` registration to be considered in read-only conversations when it declares read-only access. Update the map to revoke a grant. Descendant and workspace restrictions still apply before invocation.

Setup and live configuration callbacks register and update resources; they cannot await scope preparation, submit executions or enqueue configuration writes against the graph being changed. Use those operations from normal runtime handlers. A prepared scoped service is a current provider reference, not a stable proxy: resolve it again after configuration changes. The browser graph is committed only when its required capabilities remain available after server mounting, including replacements.
