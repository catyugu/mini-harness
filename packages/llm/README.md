# @mini-harness/llm

Defines native provider-neutral messages, tool calls, model options and streaming requests.

## Responsibilities

Owns model and thinking vocabulary, message validation, and the request snapshot contract used by execution and persistence.

## Structure

`src/api.ts` defines `LlmPort` and native protocol types. `vocabulary.ts` and `options.ts` centralize model fields and validation.

## API

`harnessLlm` and the native model interfaces are exported through the server SDK.

## Dependencies

[Models](../models/README.md) adapts the protocol to provider APIs and owns credentials.

## Testing

[Agent](../agent/tests/) and [Models](../models/tests/) verify native requests, message validation and adapter behavior.
