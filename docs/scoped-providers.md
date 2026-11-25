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

Cordis activates and disposes consumers according to their dependencies. Configured scope compositions are mounted by Cordis as consumers of their namespace owner and configured ancestors. They activate and dispose with those services. A failed configuration update restores the previous entries. Deleting a session or workspace releases its entries and removes scoped settings and data. Changing the live composition owner requires a Profile restart.

Wait for Profile configuration to settle with `await ctx.harnessProfileScopes.prepare(address, signal)`, then use the selected Cordis context directly: `ctx.harnessProfileScopes.context(address).harnessModels`, for example. Resolve it again after configuration changes. Configured scopes are mounted eagerly; unconfigured resources do not create plugin trees. Perform configuration preparation in runtime handlers.

Scope configuration contains only Entry composition and service isolation. The optional conversation tool policy handles read-only mode independently of Profile addresses; there is no separate per-plugin grant list.

## Runtime scopes

`mini-harness/scopes` provides opaque object keys, `createScopeKey(parent)`, `scopeOf(ctx)`, `scopeParentOf(key)`, `scopeChainOf(key)` and `scopeTarget(ctx, key)`. These primitives know nothing about business IDs or Profiles. `setScopeParent(key, parent?)` explicitly binds a parent and rejects cycles. Parent lookup is a WeakMap read, and event routing uses the current ancestry. Workspace and session identities last for the Profile; Sessions rebind their roots through the optional Workspace service's Fiber lifetime. `tagScope` tags a newly created Cordis context; the owning Fiber manages its lifetime. Scoped contributions inherit along the object chain; scope routing is not an access boundary.

Resource owners publish each existing address with `harnessProfileScopes.register(ctx, address, { key, parent? })`. `key` is the domain's stable runtime object, while `parent` is an optional persistent Profile address. Register a resource when it is created and call the returned disposer when it is removed; unloading the owner also removes its bindings. An absent resource leaves its configured composition inactive, not failed. Its registration activates that composition and dependent descendants through ordinary Cordis injection without restarting sibling resources or updating the Profile. Workspaces and Sessions own their identities. Configured descendant compositions wait for their ancestor bindings; disabling a domain retains its configuration without keeping its plugin subtree alive. Sessions expose `scope(id)` for standing contributions and `runScope(id)` for the execution layer. Tools, Prompt, model catalogs and LLM adapters derive runtime scope from the Cordis caller. Pass an explicit runtime key only when selecting a different resource's contributions. Display options are contributed through the plugin editor's `settings/scopes` event.
