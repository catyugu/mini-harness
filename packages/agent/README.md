# @mini-harness/agent

Executes native Agent turns and builds their system prompts.

## Responsibilities

Owns model selection for each delivery, request preparation, retries, inbox delivery, tool dispatch and context compaction. Sessions owns durable history and Conversation owns user-facing display.

## Structure

`src/manifests/` declares the Agent and Prompt plugins. `src/setup.ts` binds the Agent service. `agent.ts`, `model-request.ts`, `tool-pipeline.ts` and `prompt.ts` implement the execution stages.

## API

`harnessAgent` owns the default Agent execution. `harnessToolExecutor` schedules advertised tool call identities; the Agent retains execution authorization and result persistence. `harnessCompaction` selects a summary and retained history boundary; the Agent validates and commits the result through Sessions. Disable or replace the compaction Entry in the Profile to select a different strategy.

## Dependencies

Resolves scoped LLM, model, prompt and tool providers through the session’s Cordis Context. Appends the accepted inputs, model requests and execution results through [Sessions](../sessions/README.md).

## Lifecycle

`core:agent` and `core:prompt` mount at application scope. Runs owns the execution reservation and prepares the session scope. Agent turns carry the run’s abort signal.

## Configuration

`core:agent` declares `maxTurns` and `autoCompact` in its manifest. The caller supplies a model selection and fallback. Agent validates the choice against the scoped model catalog.

## Testing

`tests/execution.test.ts` covers native turns, tool execution, inbox delivery, compaction and historical input.
