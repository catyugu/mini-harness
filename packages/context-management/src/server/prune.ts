import { createHash } from 'node:crypto';
import type { ImagePart, NativeMessage, NativeToolMessage, NativeUserMessage } from '@mini-harness/llm/api';
import type { ContextRequest } from '@mini-harness/runs/context-management';
import type { ContextReplacement, SessionContext } from '@mini-harness/sessions/log-api';
import { messageTokens } from './meter.ts';

const attachment = /\n\nAttached file: "(?:[^"\\]|\\.)*"\n/;
const chunks = (content: NativeToolMessage['content'] | NativeUserMessage['content']) =>
  typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;

function shortened(text: string, size: number) {
  const head = Math.floor(size / 2);
  return text.slice(0, head) + '\n[… middle omitted …]\n' + text.slice(-(size - head));
}

function pruneText(text: string, size: number, customize?: (text: string, size: number) => string) {
  if (customize) {
    const excerpt = customize(text, size);
    if (typeof excerpt !== 'string' || excerpt.length > size) throw new Error('Invalid tool result excerpt');
    return excerpt;
  }
  return shortened(text, size);
}

function reference(id: string, kind: string) {
  return '[' + kind + '. Use read_context with entry "' + id + '" to retrieve the original.]';
}

export function prune(
  input: ContextRequest,
  projection: SessionContext,
  signatures: Map<string, string | null>,
  options: { offload: boolean; forceImages: boolean; toolTokens: number },
) {
  const { contextMessages, contextEntryIds, contextRevisions } = projection;
  const replacements: ContextReplacement[] = [];
  const originals = new Map<string, string>();
  let latestUser = contextMessages.length - 1;
  while (latestUser >= 0 && contextMessages[latestUser].role !== 'user') latestUser--;
  let latestExchange = contextMessages.length - 1;
  while (latestExchange >= 0) {
    const message = contextMessages[latestExchange];
    if (message.role === 'assistant' && message.content.some(({ type }) => type === 'toolCall')) break;
    latestExchange--;
  }
  let imageIndex = 0;
  const imageCount = contextMessages.reduce(
    (sum, message) =>
      sum +
      (Array.isArray(message.content) ? message.content.filter(({ type }) => type === 'image').length : 0),
    0,
  );
  for (const [index, message] of contextMessages.entries()) {
    if (message.role === 'assistant') continue;
    const id = contextEntryIds[index];
    const parts = chunks(message.content);
    const content = parts.flatMap((part, position) => {
      if (part.type === 'image') {
        const current = imageIndex++;
        if (
          options.forceImages
            ? current < Math.max(1, Math.ceil(imageCount / 2))
            : options.offload && index < (message.role === 'user' ? latestUser : latestExchange)
        )
          return [{ type: 'text' as const, text: reference(id, 'Image ' + (position + 1) + ' offloaded') }];
      }
      if (
        part.type === 'text' &&
        message.role === 'user' &&
        index < latestUser &&
        options.offload &&
        input.log.hasAttachments(id)
      ) {
        const position = part.text.search(attachment);
        if (position >= 0)
          return [
            {
              type: 'text' as const,
              text: part.text.slice(0, position) + '\n' + reference(id, 'Inlined attachments offloaded'),
            },
          ];
      }
      return [part];
    });
    let replacement: NativeMessage = { ...message, content };
    if (message.role === 'toolResult') {
      const tool = input.tools.get(message.toolName);
      // A replacement revision can never become the original for a second text prune.
      const fresh = contextRevisions[index] === id;
      let duplicate: string | undefined;
      if (!message.isError && tool?.tags?.includes('readOnly')) {
        let key = signatures.get(id);
        if (key === undefined) {
          const source = fresh ? message : input.log.originalMessage(id);
          key =
            source?.role === 'toolResult' &&
            !source.details?.stdoutOverflow &&
            !source.details?.stderrOverflow &&
            messageTokens(source) > 256
              ? createHash('sha256')
                  .update(JSON.stringify([source.toolName, source.content, source.details]))
                  .digest('hex')
              : null;
          if (signatures.size >= 4096) signatures.delete(signatures.keys().next().value!);
          signatures.set(id, key);
        }
        if (key) {
          duplicate = originals.get(key);
          if (!duplicate) originals.set(key, id);
        }
      }
      const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
      if (
        fresh &&
        (duplicate || (messageTokens(message) > options.toolTokens && text.length > options.toolTokens * 3))
      ) {
        const size = Math.max(128, Math.floor((options.toolTokens * 3) / 2));
        const excerpt = duplicate ? '' : pruneText(text, size, tool?.pruneResult);
        const outputPaths = [message.details?.stdoutOverflow, message.details?.stderrOverflow].filter(
          (value): value is string => typeof value === 'string',
        );
        const source = duplicate ? 'Identical tool output from entry ' + duplicate : 'Tool output shortened';
        replacement = {
          ...message,
          content: [
            {
              type: 'text',
              text: [excerpt, reference(id, source), ...outputPaths].filter(Boolean).join('\n'),
            },
            ...content.filter((part): part is ImagePart => part.type === 'image'),
            ...content.filter(
              ({ type, ...part }) =>
                type === 'text' && 'text' in part && /^\[Image \d+ offloaded\./.test(part.text),
            ),
          ],
        };
      }
    }
    if (
      replacement.content === content &&
      parts.length === content.length &&
      parts.every((part, position) => part === content[position])
    )
      continue;
    if (messageTokens(replacement) >= messageTokens(message) && !options.forceImages) continue;
    replacements.push({ start: index, deleteCount: 1, insert: [replacement], preserveSource: true });
  }
  if (!replacements.length) return false;
  input.log.append({ type: 'context-replace', replacements: replacements.reverse() }, projection.leafId);
  return true;
}
