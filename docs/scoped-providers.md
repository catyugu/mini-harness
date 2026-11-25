# Scoped service composition

Application, workspace and session entries use the same Cordis plugin contract. Replace an application provider by disabling it and enabling its replacement in one update. Duplicate providers in the same context are errors.

A child scope explicitly isolates the services it overrides:

```yaml
scopes:
  workspace:0123456789abcdef0123456789abcdef:
    isolate: [exampleGreeting]
    entries:
      workspace-greeting:
        name: '@example/greeting'
        disabled: false
```

Inheritance follows application → workspace → ancestor session → session. Only the services listed in `isolate` are masked. An unavailable replacement does not fall back to its parent; remove the isolation declaration to restore inheritance. Siblings are unaffected.

Cordis activates and disposes consumers according to their dependencies. Changed scopes are prepared before commit; a failed update restores the previous entries. Deleting a session or workspace releases its entries and removes scoped settings and data. Changes to services executing a configuration transaction require a Profile restart.

Prepare a Profile address with `await ctx.harnessProfileScopes.prepare(address, signal)`, then use the selected Cordis context directly: `ctx.harnessProfileScopes.context(address).harnessModels`, for example. Resolve it again after configuration changes. Perform configuration preparation in runtime handlers.

Read-only tool grants belong to the active Profile. Grant only registrations which declare read-only access. For example, the default bundle includes:

```yaml
readOnlyTools:
  files: [read, ls, find, grep]
```

The plugin Settings detail can grant or revoke read-only tools by Entry ID. The same policy applies to shipped and third-party entries. Existing conversation and workspace restrictions still apply.

## Runtime scopes

`mini-harness/scopes` provides opaque object keys, `createScopeKey(parent)`, `scopeOf(ctx)`, `scopeParentOf(key)`, `scopeChainOf(key)` and `scopeTarget(ctx, key)`. These primitives know nothing about business IDs or Profiles. `tagScope` tags a newly created Cordis context; the owning Fiber manages its lifetime. Scoped contributions inherit along the object chain; scope routing is not an access boundary.

Profile address resolvers register with `harnessProfileScopes.register(namespace, resolve, eager)` and return `{ key, parent? }` or `undefined` for an unknown address. `key` is the domain's stable runtime object, while `parent` is an optional persistent Profile address. Workspaces and Sessions own their identities. Sessions expose `scope(id)` for standing contributions and `runScope(id)` for the execution layer. Tools and Prompt receive runtime keys explicitly and share the same scoped registry mechanism. Display options are contributed through the plugin editor's `settings/scopes` event.
