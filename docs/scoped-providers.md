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

Cordis activates and disposes consumers according to their dependencies. Changed scopes are prepared before commit; a failed update restores the previous entries. Deleting a session or workspace releases its entries and removes scoped settings, grants and data. Changes to services executing a configuration transaction require a Profile restart.

Use `await sessionService(ctx, sessionId, name, signal)` to resolve a service for a visible session. Resolve it again after configuration changes. Setup and live configuration callbacks register resources; perform session writes, execution submission and scope preparation in runtime handlers.

Read-only tool grants belong to the active Profile. Grant only registrations which declare read-only access. For example, the default bundle includes:

```yaml
readOnlyTools:
  files:
    module: '@mini-harness/files'
    tools: [read, ls, find, grep]
```

For a scoped Entry, the grant key is its scope key followed by `/` and Entry ID. Local and installed module identities use resolved file URLs. The plugin Settings detail shows the actual registration identity and can grant or revoke tools. Replacing a module does not transfer its grants; inherited restrictions still apply.
