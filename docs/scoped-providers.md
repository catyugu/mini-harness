# Scoped service composition

Enable the Cordis entries that provide the services you want. At application
scope, replace a service by disabling its original entry and enabling the new
entry together. Cordis rejects duplicate services in the same Context.

A workspace or session can enable its own entry declaring the services that
should be isolated from the parent. For example:

```yaml
scopes:
  workspace:0123456789abcdef0123456789abcdef:
    plugins:
      workspace-greeting: true
```

Scopes inherit services from application → workspace → ancestor session →
session. A local entry isolates its declared services in that subtree; disable
it to restore inheritance. Siblings and ancestors retain their services. A
local entry can replace one service from an inherited multi-service entry.
Changed scoped entries are prepared before configuration is committed.
If a configured entry fails during startup, its isolated services remain
unavailable rather than falling back silently.

The current host infrastructure and final tool authorization services are
protected. Business services use the normal Cordis composition mechanism.

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

Enabled entries and scoped plugin configuration are written to the active [Profile](profiles.md). Tool grants and scoped tool restrictions are saved as domain settings.
