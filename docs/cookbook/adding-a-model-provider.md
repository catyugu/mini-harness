# Add a model provider

Start with [create a plugin](creating-a-plugin.md). A complete provider contributes discovery and streaming together; a transport-only adapter deliberately reuses existing catalog capabilities.

Import `ModelSource` from `mini-harness/models` and `LlmAdapter` from `mini-harness/llm`. Implement the source's `list`, `resolve` and `capabilities` methods (and optional `available`); implement the adapter's `accepts` predicate and async `stream` generator. Translate provider messages and streaming events into the native message contract, honor request cancellation, and keep provider credentials and continuation details inside the adapter.

With those two implementations, mount the paired registration:

```ts
import type { Context } from 'mini-harness/cordis';
import type { ModelSource } from 'mini-harness/models';
import type { LlmAdapter } from 'mini-harness/llm';

export function registerProvider(ctx: Context, source: ModelSource, adapter: LlmAdapter) {
  ctx.effect(() => ctx.harnessModels.register(source, adapter));
}
```

The plugin must inject `harnessModels`. This snippet is the registration step, not a complete provider. Do not call the aggregate catalog from `accepts`. Add the built plugin to the Profile, choose a model from its catalog and send a message. Test selection, stream completion, cancellation and removal; the [extension integration tests](../../test/plugins/extensions.test.ts) demonstrate alternate adapters and catalog sources.

See [Models](../../packages/models/README.md) for paired discovery and [LLM](../../packages/llm/README.md) for protocol and selection. Use [scoped providers](../scoped-providers.md) to replace services for one resource without affecting siblings.
