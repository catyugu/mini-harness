import type { Attachment } from '@mini-harness/contracts/input';
import type { Conversation, ModelChoice } from '@mini-harness/contracts/conversation';
import type { RunEvent, RunInfo } from '@mini-harness/contracts/transport';
import type { ConversationView } from '../types.js';
import { payload, workspaceRoute } from '../api.js';
import { readConversation, observeRun } from '../transport/session-client.js';
type BrowserRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

/** No DOM state or browser layout dependencies: the conversation command boundary. */
export function createConversationController(request: BrowserRequest) {
  return {
    read: (id: string, signal: AbortSignal) => readConversation(id, signal),
    follow: (view: ConversationView, signal: AbortSignal, accept: (event: RunEvent) => void, reconnect: () => void) =>
      observeRun(view, signal, accept, reconnect),
    create: (workspaceId: string) => request<Conversation>(workspaceRoute(workspaceId, '/sessions'), payload('POST', {})),
    start: (id: string, input: { message: string; attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: string }) =>
      request<RunInfo>('/sessions/' + id + '/runs', payload('POST', input)),
    queue: (id: string, input: { message: string; mode: 'steer' | 'followUp';
      attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: string }) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue', payload('POST', input)),
    getQueue: (id: string, signal: AbortSignal) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue', { signal }),
    cancelQueue: (id: string, item?: string) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue' + (item ? '/' + encodeURIComponent(item) : ''), { method: 'DELETE' }),
    compact: (id: string) => request('/sessions/' + id + '/compact', payload('POST', {})),
    cancel: (id: string) => request('/sessions/' + id + '/cancel', payload('POST', {}))
  };
}
