# Add a model provider

A provider pairs model discovery with a streaming adapter. The complete [local echo example](../examples/model-provider/plugin.ts) uses public SDK imports and runs without a network service or credentials. It demonstrates registration and native events; it does not perform inference or call tools.

## 1. Define discovery and capabilities

Implement `ModelSource` from `mini-harness/models`. The example advertises `example/echo` through `list`, returns the exact provider/model pair with its text-only capabilities through `resolve`. `available` is optional when discovery does not need asynchronous work.

Use the catalog to publish choices and capabilities. Keep connection details and credentials in the provider implementation. [Models](../../packages/models/README.md) owns catalog selection and the relationship between model sources and adapters.

## 2. Translate the native stream

Implement `LlmAdapter` from `mini-harness/llm`. Its `accepts` predicate checks only the requested choice; it must not call the aggregate catalog or adapter selector. The example reads the last user message, emits a `text-delta`, then a `done` event containing the complete native assistant message.

For a real provider, pass the request signal through to network I/O, translate tool calls and reasoning explicitly, and preserve required provider continuation/signature data. A terminal message includes the full response, not only its final chunk. Do not emit a completed answer after cancellation. [LLM](../../packages/llm/README.md) defines the supported content and failure contracts.

## 3. Register and enable it

The example injects `harnessModels` and binds the pair to one activation:

```ts
import type { Context } from 'mini-harness/cordis';
import type { ModelSource } from 'mini-harness/models';
import type { LlmAdapter } from 'mini-harness/llm';

export function registerProvider(ctx: Context, source: ModelSource, adapter: LlmAdapter) {
  ctx.effect(() => ctx.harnessModels.register(source, adapter));
}
```

Build the repository, then add this entry to the example Profile created in [create a plugin](creating-a-plugin.md):

```yaml
plugins:
  - id: example-provider
    name: /absolute/path/to/mini-harness/dist/docs/examples/model-provider
```

Start the Profile and choose **Example echo** in the model selector. Sending `Hello` produces `Echo: Hello`. Disable the entry and confirm its model disappears from discovery. The effect unregisters discovery and transport together.

## 4. Adapt and verify the provider

Replace the deterministic stream with your provider's API while keeping the public contracts. Check a completed response, provider failure, cancellation and disabling the Entry during streaming. Calling the registration's disposer removes future selection; disposing the provider Fiber cancels its in-flight streams. Use [extension tests](../../test/plugins/extensions.test.ts) for examples of native tool calls, retry hooks and scoped adapter replacement. The build compiles the echo example; compilation alone does not verify an external provider's protocol.

A transport-only override can register with `harnessLlm` when it deliberately reuses an existing catalog's capabilities. Use [scoped composition](../scoped-providers.md) to target a workspace or session. Registering a model source does not require implementing the built-in Pi provider store or its settings UI.
