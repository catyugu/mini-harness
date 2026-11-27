# Models

Models owns model discovery, the default provider and credential store, and the recent application model. It supplies independently replaceable capabilities so an external provider can own its own configuration without depending on the Pi store.

## Model contributions

[`mini-harness/models`](src/server/api.ts) exposes `ModelSource`, `ModelCatalogPort` and `ModelPreference`. A source lists discoverable models, resolves choices and supplies capabilities; optional `available()` can wait for asynchronous availability information. [`mini-harness/models/catalog`](src/shared/catalog.ts) defines catalog and capability records.

Inject `harnessModels` and register a source with its matching [LLM adapter](../llm/README.md):

```ts
import type { Context } from 'mini-harness/cordis';
import type { LlmAdapter } from 'mini-harness/llm';
import type { ModelSource } from 'mini-harness/models';

export function registerProvider(ctx: Context, source: ModelSource, adapter: LlmAdapter) {
  ctx.effect(() => ctx.harnessModels.register(source, adapter));
}
```

The catalog registers both parts with the same scope, priority and activation lifetime. The nearest scope wins, then higher priority; equal-ranked contributions are ambiguous and omitted from discovery. Catalog metadata and a paired adapter must agree. A transport-only override through `harnessLlm.register` deliberately reuses the selected source's capabilities. The LLM service publishes `llm/adapters-changed` after registration changes. A mutable source publishes `models/source-changed` with `catalog` for structural changes or `auth` for authentication changes. Paired registrations and changes during graph reconciliation publish once at the settled boundary. Auth changes invalidate the browser projection without revalidating the recent choice.

A source may resolve a dynamic model ID that it does not enumerate. Its adapter's `accepts` predicate must not call the aggregate catalog. See [adding a model provider](../../docs/cookbook/adding-a-model-provider.md) for a complete extension workflow.

## Built-in composition and storage

The [base Profile](../../profiles/base.yml) separates the model catalog, model store, Pi adapter and recent model into individual entries. The catalog requires LLM selection; the Pi adapter requires the store and catalog. The Web Profile adds provider administration and the browser model selector through `core:model-admin`.

The built-in [store](src/server/store.ts) reads `models.json` under the application configuration directory. Its `providers` object holds custom definitions and their catalogs; its optional `builtins` object holds endpoint and catalog overrides by built-in Provider ID. An omitted built-in `models` field inherits the adapter's catalog. An explicit empty array hides all of that provider's models. The store resolves persisted configuration and native definitions into the effective catalog at commit time. An edited built-in model stores its native `templateId` explicitly, independent of previous overrides and model renames. Every saved model definition contains its complete editable metadata; HTTP edits and file loading validate the same fields. Independent models use the provider connection. Optional `thinkingLevelMap`, `compat`, and `cost` use the Pi SDK's typed schemas; compatibility fields are validated against the effective API. The editor preserves these settings. When changing a custom provider's protocol, saving requires confirmation if the draft contains model `compat` or `thinkingLevelMap`. Confirming clears these two fields; cost and editable metadata remain intact. Connection fields (`api`, `baseUrl`, `headers`) remain provider-owned. Native template metadata remains adapter-owned; a missing native template makes its derived model unavailable. Built-in models continue to use their native Pi adapter and authentication.

**Settings → Model** uses the same editor to add and edit a provider. Custom providers have a fixed ID, an editable display name, an endpoint, a protocol and a catalog. The editor accepts an empty catalog, manual model entries, reordering and explicit model capabilities. **Restore default models** replaces a built-in editor's draft with the adapter's current default catalog. Save applies it. The built-in store resolves only model IDs in the effective catalog.

**Fetch available models** works from the draft when the server-advertised protocol supports discovery. The default adapter defines and validates supported protocols, labels, loaders and discovery together. Provider administration and protocol choices are exposed only while the Pi adapter is active. The server queries the configured endpoint; discovery makes no configuration changes. Use an API key entered in the draft when testing a different endpoint. The server deduplicates Model IDs. The picker starts with the currently configured IDs selected (all when no ID has been entered). Applying the selection adds newly selected models, removes deselected listed models, and keeps manual models outside the listing and existing settings for retained models. An empty selection may produce an empty catalog. Listing metadata supplies capabilities where available, otherwise the shared defaults apply.

Saved keys belong to the `auth.json` credential store and are never returned to the editor. A blank key field keeps the saved credential. Removing a built-in provider clears its saved settings and credential, returning it to its adapter defaults. Removing a custom provider deletes its definition and credential. Writes are serialized. Persistence failures retain the previous working store; after a successful write the effective catalog is published without waiting for authentication. The credential store owns a shared file snapshot, replaced on successful writes and reloaded on explicit store refresh. Local custom credentials are resolved synchronously. `list()` returns a snapshot; `available()` joins existing native authentication checks without starting new ones. Only configuration changes, native provider registration or explicit store refresh initiate checks. External file edits require reload or restart. Provider edits never wait for those checks. Replaced and removed checks are aborted, successors wait for their predecessors, and adapter/store disposal drains owned checks. Authentication results publish independently of catalog structure. Native authentication checks have a five-second per-provider deadline and must settle on abort. A failed or timed-out check is reported and leaves only that provider unconfigured until an explicit refresh or provider change, without hiding its saved credential.

`harnessModelStore` is an internal capability of the default provider implementation, not an installed SDK export. Third-party providers use the public source/adapter contract and their own persistence.

## Model selection and preferences

[`mini-harness/models/selection`](src/server/selection.ts) provides model, thinking-level and image-capability selection helpers. An explicit unknown model is an error. An inherited thinking level is retained only when supported; explicit `null` clears it. New images require an image-capable model, while historical images can be presented as text placeholders.

The optional `harnessModelPreference` tracks the recent application choice. Accepted user input from a root user run updates it; child and plugin runs do not overwrite it. The browser sees the selection immediately while persistence writes are ordered and drained. The catalog observes source and adapter changes and publishes availability against a settled Profile graph, including after a successful rollback. The preference owner subscribes only to catalog changes. Observation failures are logged without failing the committed operation. Persistence failure is reported by that owner without failing an accepted run or provider edit.

The `core:models` [configuration schema](src/manifests/models.ts) contains the recent `model`, initially empty. Its entry is live in the base Profile. Profile configuration owns persistence; the Settings UI presents it. Provider endpoint and credential administration is a separate surface.

## Verification

[Adapter tests](tests/adapter.test.ts) cover native protocol conversion, credentials, refresh failures and cancellation. [Preference tests](../../test/system/model-persistence.test.ts) cover scoped runs, restarts and failed writes. See [scoped providers](../../docs/scoped-providers.md), [configuration](../../docs/configuration.md) and the [package index](../../docs/packages.md).

The browser `miniModels` service supplies a complete Model Picker for Composer and Context settings. Models owns its catalog subscription, trigger, search, options and popover. Callers place the returned node, set their current choice and handle selection.
