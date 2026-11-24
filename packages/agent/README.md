# @mini-harness/agent

Executes native Agent turns and builds their system prompts.

## Responsibilities

Owns model selection for each delivery, the execution lease, request preparation, retries, inbox delivery, tool dispatch and context compaction. Sessions owns durable history and Conversation owns user-facing display.

## Structure

`src/manifests/` declares the Agent and Prompt plugins. `src/setup.ts` binds the Agent routes and service. `agent.ts`, `model-request.ts`, `tool-pipeline.ts` and `prompt.ts` implement the execution stages.

## API

`harnessAgent` is an internal execution service. `harnessPrompt`, `promptExtensions` and `agentExtensions` are available through the [server SDK](../sdk/README.md).

## Dependencies

Resolves scoped LLM, model, prompt and tool providers through [Kernel](../kernel/README.md). Appends the accepted inputs, model requests and execution results through [Sessions](../sessions/README.md).

## Lifecycle

`core:agent` and `core:prompt` mount at application scope. Turns acquire a session lease and carry an abort signal. Session deletion waits for Agent work to finish.

## Configuration

`core:agent` declares `maxTurns` and `autoCompact` in its manifest. Model capabilities and the recent model come from [Models](../models/README.md).

## Testing

`tests/execution.test.ts` covers native turns, tool execution, inbox delivery, compaction and historical input.
