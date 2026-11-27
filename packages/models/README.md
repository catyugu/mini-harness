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

The built-in [store](src/server/store.ts) reads provider definitions from `models.json` and credentials from `auth.json` under the application configuration directory. Credentials and connection details stay inside the provider boundary; catalog responses expose model metadata and authentication status. Credential writes are serialized and drained on disposal. Failed updates retain the previous working store.

`harnessModelStore` is an internal capability of the default provider implementation, not an installed SDK export. Third-party providers use the public source/adapter contract and their own persistence.

## Model selection and preferences

[`mini-harness/models/selection`](src/server/selection.ts) provides model, thinking-level and image-capability selection helpers. An explicit unknown model is an error. An inherited thinking level is retained only when supported; explicit `null` clears it. New images require an image-capable model, while historical images can be presented as text placeholders.

The optional `harnessModelPreference` tracks the recent application choice. Accepted user input from a root user run updates it; child and plugin runs do not overwrite it. The browser sees the selection immediately while persistence writes are ordered and drained. Persistence failure is reported by the preference owner without failing an accepted run.

The `core:models` [configuration schema](src/manifests/models.ts) contains the recent `model`, initially empty. Its entry is live in the base Profile. Profile configuration owns persistence; the Settings UI presents it. Provider endpoint and credential administration is a separate surface.

## Verification

[Adapter tests](tests/adapter.test.ts) cover native protocol conversion, credentials, refresh failures and cancellation. [Preference tests](../../test/system/model-persistence.test.ts) cover scoped runs, restarts and failed writes. See [scoped providers](../../docs/scoped-providers.md), [configuration](../../docs/configuration.md) and the [package index](../../docs/packages.md).

The browser `miniModels` service supplies a complete Model Picker for Composer and Context settings. Models owns its catalog subscription, trigger, search, options and popover. Callers place the returned node, set their current choice and handle selection.
