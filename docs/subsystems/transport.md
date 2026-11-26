# Server and browser transport

[Transport](../../packages/transport/README.md) provides HTTP route registration, upgrades, response framing and revision notifications. [Host](../../packages/host/README.md) supplies the listener, credential and authentication gate. Feature packages own request payloads, validation and resource operations.

[UI Gateway](../../packages/ui-gateway/README.md) exposes the bootstrap graph from Plugins and the change feed from Transport. [UI Runtime](../../packages/ui-runtime/README.md) loads browser entries, makes authenticated requests and refreshes projections when a revision changes or connectivity returns.

Revision notifications identify the affected projection domain and resource. A consumer reads the authoritative domain snapshot rather than treating the change stream as its data store. Run replay is separate: Runs exposes sequenced transient execution events, with durable conversation history from Sessions. Disconnecting a browser does not cancel execution.

Route registrations and subscriptions have activation/request lifetimes. Removing a route cancels and drains pending handler calls. If a handler returns while leaving a response stream open, the feature owns that stream's later cleanup; global Transport shutdown closes open responses. Browser plugins bind requests and view subscriptions to their own lifetime. Scope-addressed calls use the mounted composition, not an arbitrary client-chosen server object.

See the owning packages for the exact route, revision and replay contracts; see [security](../../SECURITY.md) for the trust boundary.
