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
parent's provider, and deleting or disabling a local provider restores inherited
resolution. A second instance of the same provider ID still needs an explicit
choice to shadow its ancestor.

Consumers call `harnessScopes.prepare(sessionId, signal)` before reading
`harnessScopes.resolve(sessionId, serviceName)`. This resolves the nearest live
Cordis service, so the native agent executes through the selected LLM, tool and
environment services. Plugins declaring `inject` receive services from their own
scope's context.

The graph is validated before setup. Provider changes restart their dependent
plugins in dependency order and await cleanup. A failed setup or configuration
write restores the previous graph. Application replacements must replace a
multi-service plugin as a unit; scoped replacements leave the parent mounted.
