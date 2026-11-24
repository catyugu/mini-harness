# @mini-harness/input

Validates user text and attachments and converts them to model-facing input.

## Responsibilities

Owns input source and attachment formats, size and media constraints, and the original presentation metadata attached to committed input.

## Structure

`src/message.ts` defines input contracts. `src/prepare.ts` validates and prepares attachments and text.

## API

`PreparedMessage` and `InputSource` are available through the server SDK. Sessions uses the shared input preparation for Runs and Agent. It returns model-visible content, presentation metadata and validated original bytes for session-owned storage.

## Dependencies

Uses [Platform](../platform/README.md) for domain errors.

## Testing

[Agent execution tests](../agent/tests/execution.test.ts) cover input validation, historical images and model capability differences.
