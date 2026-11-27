# Models

Models owns model discovery, the default provider and credential store, and the recent application model. It supplies independently replaceable capabilities so an external provider can own its own configuration without depending on the Pi store.

## Model contributions

[`mini-harness/models`](src/server/api.ts) exposes `ModelSource`, `ModelCatalogPort` and `ModelPreference`. A source lists discoverable models, resolves choices and supplies capabilities; optional `available()` can refresh discovery asynchronously. [`mini-harness/models/catalog`](src/shared/catalog.ts) defines catalog and capability records.

Inject `harnessModels` and register a source with its matching [LLM adapter](../llm/README.md):

```ts
import type { Context } from 'mini-harness/cordis';
import type { LlmAdapter } from 'mini-harness/llm';
import type { ModelSource } from 'mini-harness/models';

export function registerProvider(ctx: Context, source: ModelSource, adapter: LlmAdapter) {
  ctx.effect(() => ctx.harnessModels.register(source, adapter));
}
```

The catalog registers both parts with the same scope, priority and activation lifetime. The nearest scope wins, then higher priority; equal-ranked contributions are ambiguous and omitted from discovery. Catalog metadata and a paired adapter must agree. A transport-only override through `harnessLlm.register` deliberately reuses the selected source's capabilities.

A source may resolve a dynamic model ID that it does not enumerate. Its adapter's `accepts` predicate must not call the aggregate catalog. See [adding a model provider](../../docs/cookbook/adding-a-model-provider.md) for a complete extension workflow.

## Built-in composition and storage

The [base Profile](../../profiles/base.yml) separates the model catalog, model store, Pi adapter and recent model into individual entries. The catalog requires LLM selection; the Pi adapter requires the store and catalog. The Web Profile adds provider administration and the browser model selector through `core:model-admin`.

The built-in [store](src/server/store.ts) reads `models.json` under the application configuration directory. Its `providers` object holds custom definitions and their catalogs; its optional `builtins` object holds endpoint and catalog overrides by built-in Provider ID. An omitted built-in `models` field inherits the adapter's catalog. An explicit empty array hides all of that provider's models. The store resolves persisted configuration and native definitions into the effective catalog at commit time. An edit identifies its original model explicitly, preserving native protocol and adapter settings across renames. Newly added models use the provider's connection defaults. Built-in models continue to use their native Pi adapter and authentication.

**Settings → Model** uses the same editor to add and edit a provider. Custom providers have a fixed ID, an editable display name, an endpoint, a protocol and a catalog. The editor accepts an empty catalog, manual model entries, reordering and explicit model capabilities. **Restore default models** replaces a built-in editor's draft with the adapter's current default catalog. Save applies it. The built-in store resolves only model IDs in the effective catalog.

**Fetch available models** works from the draft when the server-advertised protocol supports discovery. The default adapter defines protocol labels, loaders and discovery together. The server queries the configured endpoint; discovery makes no configuration changes. Use an API key entered in the draft when testing a different endpoint. The picker deduplicates Model IDs and keeps existing model settings. Listing metadata supplies capabilities where available, otherwise the shared defaults apply.

Saved keys belong to the `auth.json` credential store and are never returned to the editor. A blank key field keeps the saved credential. Removing a built-in provider clears its saved settings and credential, returning it to its adapter defaults. Removing a custom provider deletes its definition and credential. Writes are serialized and failed updates retain the previous working store.

`harnessModelStore` is an internal capability of the default provider implementation, not an installed SDK export. Third-party providers use the public source/adapter contract and their own persistence.

## Model selection and preferences

[`mini-harness/models/selection`](src/server/selection.ts) provides model, thinking-level and image-capability selection helpers. An explicit unknown model is an error. An inherited thinking level is retained only when supported; explicit `null` clears it. New images require an image-capable model, while historical images can be presented as text placeholders.

The optional `harnessModelPreference` tracks the recent application choice. Accepted user input from a root user run updates it; child and plugin runs do not overwrite it. The browser sees the selection immediately while persistence writes are ordered and drained. The preference owner revalidates the current choice after committed catalog and profile changes, not transient plugin activation states. Persistence failure is reported by that owner without failing an accepted run or provider edit.

The `core:models` [configuration schema](src/manifests/models.ts) contains the recent `model`, initially empty. Its entry is live in the base Profile. Profile configuration owns persistence; the Settings UI presents it. Provider endpoint and credential administration is a separate surface.

## Verification

[Adapter tests](tests/adapter.test.ts) cover native protocol conversion, credentials, refresh failures and cancellation. [Preference tests](../../test/system/model-persistence.test.ts) cover scoped runs, restarts and failed writes. See [scoped providers](../../docs/scoped-providers.md), [configuration](../../docs/configuration.md) and the [package index](../../docs/packages.md).

The browser `miniModels` service supplies a complete Model Picker for Composer and Context settings. Models owns its catalog subscription, trigger, search, options and popover. Callers place the returned node, set their current choice and handle selection.
