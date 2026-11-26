# Scoped service composition

Application, workspace and session entries use the same Cordis plugin contract. The configuration selects which services a resource inherits and where a replacement is mounted. Runtime scope identity and persistent Profile addresses are separate contracts; [Plugin API](../packages/plugin-api/README.md#scope-contracts) owns their helper types and functions.

## Configure a replacement

At the application level, disable the existing provider and enable its replacement in one update. Two providers of the same service in one Context conflict.

A child scope explicitly isolates the services it overrides. Add a scopes map to the Profile's `cordis.patch.yml`, using an actual workspace or session ID:

```yaml
scopes:
  workspace:0123456789abcdef0123456789abcdef:
    isolate: [exampleGreeting]
    entries:
      workspace-greeting:
        name: '@example/greeting'
        disabled: false
```

Inheritance follows application → workspace → ancestor session → session. Only the named services are masked. If an isolated replacement is unavailable, the child does not fall back to its parent; removing the isolation declaration restores inheritance. Sibling scopes are unaffected. The `entries` field is a map keyed by Entry ID, unlike the top-level YAML `plugins` list. [Profiles](profiles.md#layer-precedence) documents replacement of the scopes map across layers.

Configured compositions are ordinary Cordis consumers of their namespace owner and configured ancestors. They activate when those dependencies and resources exist. Unconfigured resources do not allocate plugin trees or one Cordis service per historical record. A rejected composition update restores the prior entries; changing the live composition owner itself requires a Profile restart.

## Resolve a configured composition

In a runtime handler, wait for the requested address to settle before using its services:

```ts
import type { Context } from 'mini-harness/cordis';
import type { ScopeAddress } from 'mini-harness/configuration';
import type { ModelChoice } from 'mini-harness/llm/vocabulary';
import 'mini-harness/models';

export async function resolveModel(
  ctx: Context,
  address: ScopeAddress,
  choice: ModelChoice,
  signal: AbortSignal,
) {
  await ctx.harnessProfileScopes.prepare(address, signal);
  return ctx.harnessProfileScopes.context(address).harnessModels.resolve(choice);
}
```

The caller must inject `harnessProfileScopes`; the selected composition must supply the requested domain service. Resolve the Context again after configuration changes instead of caching a removed provider. The [Task notes follow-up](examples/task-notes/plugin.ts) demonstrates this sequence in an authenticated route.

Preparing configuration is a runtime operation, not a plugin-setup dependency substitute. Tools, prompt sections, model catalogs and LLM adapters use the calling Cordis Context and their capability-specific contribution rules. Pass a runtime scope key explicitly only when an API needs to select another resource's contributions.

## Bind domain identities

Workspaces and Sessions own resource identity and ancestry. Each domain registers one namespace resolver with `harnessProfileScopes.register(owner, namespace, resolve)`. It resolves an address to `{ key, parent? }`, or returns `undefined` for an absent resource. After membership or ancestry changes, the owner notifies `changed(address)`.

Plugins watches configured compositions and the ancestor bindings they need. An absent resource leaves its composition inactive. Unloading the domain owner releases its resolver and dependent compositions while retaining their configuration; unrelated siblings continue. Deleting the resource also removes its scoped configuration and private plugin data through the domain deletion workflow. [Session coordination](subsystems/sessions.md) covers the durable deletion order.

Runtime scope keys are opaque objects. Sessions exposes standing and execution identities through `scope(id)` and `runScope(id)`; workspace ancestry follows the optional Workspace provider's lifetime. The plugin editor receives available scope choices through `settings/scopes`. These are contribution-routing mechanisms, not access boundaries: read-only conversation policy, File Access and Sandbox retain their own contracts.

See [composition](subsystems/composition.md), [Plugins](../packages/plugins/README.md) and the [scoped example](examples/scoped-tool/plugin.ts) for the cooperating owners.
