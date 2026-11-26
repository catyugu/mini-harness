# Input

Input defines user-message and attachment contracts and validates submitted content before it becomes model input. It owns conversion and validation, while [Sessions](../sessions/README.md) owns original-byte storage and [Runs](../runs/README.md) owns admission and durable delivery.

## Public contracts and usage

The browser-safe `mini-harness/input` export exposes the types in [message.ts](src/message.ts):

- `Attachment`: a name, MIME type and canonical base64 payload submitted by a client.
- `ImageInput`: a model-facing image block.
- `InputAttachment`: the presentation metadata and optional stored content identity.
- `PreparedMessage`: original user text and attachment metadata, with original images when preparation changed the model-facing images.
- `InputSource`: `user`, `agent` or `plugin`, allowing preparation hooks to distinguish the source.

For example, a caller can supply a UTF-8 attachment through a Runs input:

```ts
import type { Attachment } from 'mini-harness/input';

const attachments: Attachment[] = [{ name: 'note.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }];
```

Pass this array with the message to the [Runs API](../runs/README.md). External consumers should use Runs or `harnessSessions.prepareInput` when session-owned input preparation is needed. The private `prepareInput` function is not exported as `mini-harness/input/prepare`.

## Preparation behavior

[prepare.ts](src/prepare.ts) validates the entire input and returns model-visible text, image blocks, original presentation metadata and original bytes keyed by a SHA-256 content identity. The function itself does not create files. Sessions persists those validated bytes and returns the model/presentation portion to its caller.

The current contract accepts at most eight attachments, up to 6 MiB each and 12 MiB combined. Text is bounded to 200,000 characters; an empty message requires an attachment. Attachment names, base64 encoding and MIME data are validated, and PNG, JPEG, GIF and WebP images must match their expected file signatures. Validation failures use the shared `invalid_input` operational error.

Small valid UTF-8 text attachments are included in model text. Supported images become image blocks. Other uploads remain stored originals with a model-facing description explaining that the file was not inlined. The byte and type checks in the source are authoritative; this package does not decode arbitrary documents or execute attachment content.

Preparation preserves the submitted user text for display independently from augmented model input. It does not select a model or decide whether that model accepts images. Agent and Runs apply the selected model's capabilities and persist the accepted input through Sessions.

## Testing and dependencies

Input depends only on generic platform errors and Node's byte/hash operations. It has no plugin entry, mutable shared service or Config schema.

[Input tests](tests/prepare.test.ts) cover encoding, image signatures and attachment limits. [Run execution tests](../runs/tests/agent-execution.test.ts) cover model-capability handling. [API feature tests](../../test/system/api-features.test.ts) cover original upload storage and retrieval, including conversations without a workspace. [Session log tests](../sessions/tests/log.test.ts) cover the separation of model input and original presentation.
