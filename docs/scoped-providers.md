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

A provider must be enabled in the scope where it is selected. A fixed built-in
service or application infrastructure service cannot be overridden. Inherited
provider maps remain unchanged, so a sibling workspace inherits the original
service. The graph is validated before Cordis mounts the candidate.

This is a scoped-provider foundation, **not** the complete native Agent Loop
or Session Log implementation from the overall refactoring plan.
