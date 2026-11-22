import type { Attachment } from '../../src/input.js';
import type { Conversation, ModelChoice } from '../../src/registry.js';
import type { RunEvent, RunInfo } from '../../src/protocol.js';
import type { ConversationView } from '../types.js';
import { payload, workspaceRoute } from '../api.js';
import { readConversation, observeRun } from '../transport/session-client.js';
import type { FrontendApi } from '../kernel/extensions.js';

/** No DOM state or browser layout dependencies: the conversation command boundary. */
export function createConversationController(request: FrontendApi['request']) {
  return {
    read: (id: string, signal: AbortSignal) => readConversation(id, signal),
    follow: (view: ConversationView, signal: AbortSignal, accept: (event: RunEvent) => void, reconnect: () => void) =>
      observeRun(view, signal, accept, reconnect),
    create: (workspaceId: string) => request<Conversation>(workspaceRoute(workspaceId, '/sessions'), payload('POST', {})),
    start: (id: string, input: { message: string; attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: string }) =>
      request<RunInfo>('/sessions/' + id + '/runs', payload('POST', input)),
    queue: (id: string, input: { message: string; mode: 'steer' | 'followUp'; attachments?: Attachment[] }) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue', payload('POST', input)),
    getQueue: (id: string, signal: AbortSignal) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue', { signal }),
    compact: (id: string) => request('/sessions/' + id + '/compact', payload('POST', {})),
    cancel: (id: string) => request('/sessions/' + id + '/cancel', payload('POST', {}))
  };
}
