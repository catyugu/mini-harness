import type { ContextReplacement, SessionContext } from '@mini-harness/sessions/log-api';

const toolLimit = 8000;

function reference(id: string, label: string) {
  return '[' + label + '. Use read_context with entry "' + id + '" to retrieve the original.]';
}

function excerpt(text: string, limit: number) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head - 3;
  return tail > 0 ? text.slice(0, head) + '…\n' + text.slice(-tail) : text.slice(0, limit);
}

/** Bound text per tool result, retaining the positions of original image parts. */
export function prune({ contextMessages, contextEntryIds }: SessionContext): ContextReplacement[] {
  return contextMessages.flatMap((message, start) => {
    if (message.role !== 'toolResult') return [];
    const texts = message.content.filter((part) => part.type === 'text');
    if (texts.reduce((sum, part) => sum + part.text.length, 0) <= toolLimit) return [];
    const paths = [message.details?.stdoutOverflow, message.details?.stderrOverflow].filter((value): value is string => typeof value === 'string');
    const diagnostics = typeof message.details?.diagnostics === 'string' ? message.details.diagnostics : '';
    const note = '\n' + reference(contextEntryIds[start], 'Tool output shortened') + '\n' + [diagnostics, ...paths].join('\n').slice(0, 1500);
    const limit = Math.floor((toolLimit - note.length) / texts.length);
    let annotated = false;
    const content = message.content.map((part) => {
      if (part.type !== 'text') return part;
      const text = excerpt(part.text, limit);
      if (annotated || text === part.text) return { ...part, text };
      annotated = true;
      return { ...part, text: text + note };
    });
    return [{ start, deleteCount: 1, preserveSource: true, insert: [{ ...message, content }] } satisfies ContextReplacement];
  }).reverse();
}

/** Under pressure offload historical images; after image rejection offload the oldest remaining group. */
export function offloadImages({ contextMessages, contextEntryIds }: SessionContext, includeLatest: boolean): ContextReplacement[] {
  const latest = contextMessages.reduce((index, message, i) => message.role === 'user' ? i : index, -1);
  const result: ContextReplacement[] = [];
  for (const [start, message] of contextMessages.entries()) {
    if (message.role === 'assistant' || typeof message.content === 'string' || (!includeLatest && start >= latest)) continue;
    const parts = message.content;
    const content = parts.map((part, index) => part.type === 'image'
      ? { type: 'text' as const, text: reference(contextEntryIds[start], 'Image ' + (index + 1) + ' offloaded') }
      : part);
    if (content.every((part, index) => part === parts[index])) continue;
    result.push({ start, deleteCount: 1, preserveSource: true, insert: [{ ...message, content }] });
    if (includeLatest) break;
  }
  return result.reverse();
}
