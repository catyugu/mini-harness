# @mini-harness/agent

Executes native Agent turns and builds their system prompts.

## Responsibilities

Owns model selection for each delivery, request preparation, retries, inbox delivery, tool dispatch and context compaction. Sessions owns durable history and Conversation owns user-facing display.

## Structure

`src/manifests/` declares the Agent and Prompt plugins. `src/setup.ts` binds the Agent service. `agent.ts`, `model-request.ts`, `tool-pipeline.ts` and `prompt.ts` implement the execution stages.

## API

`harnessAgent` is an internal execution service. `harnessPrompt`, `promptExtensions` and `agentExtensions` are available through the [server SDK](../sdk/README.md).

## Dependencies

Resolves scoped LLM, model, prompt and tool providers through [Kernel](../kernel/README.md). Appends the accepted inputs, model requests and execution results through [Sessions](../sessions/README.md).

## Lifecycle

`core:agent` and `core:prompt` mount at application scope. Runs owns the execution reservation and prepares the session scope. Agent turns carry the run’s abort signal.

## Configuration

`core:agent` declares `maxTurns` and `autoCompact` in its manifest. The caller supplies a model selection and fallback. Agent validates the choice against the scoped model catalog.

## Testing

`tests/execution.test.ts` covers native turns, tool execution, inbox delivery, compaction and historical input.
