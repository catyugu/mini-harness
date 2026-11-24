import type { Attachment } from '@mini-harness/input/message';
import type { Conversation, ConversationView } from '../../view.js';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { RunEvent } from '@mini-harness/runs/stream';
import type { RunInfo } from '@mini-harness/sessions/run-state.browser';
import { payload } from '@mini-harness/ui-runtime/http';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { readConversation, observeRun } from '../session-client.js';
type BrowserRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

/** No DOM state or browser layout dependencies: the conversation command boundary. */
export function createConversationController(request: BrowserRequest) {
  return {
    read: (id: string, signal: AbortSignal) => readConversation(id, signal),
    follow: (view: ConversationView, signal: AbortSignal, accept: (event: RunEvent) => void, reconnect: () => void) =>
      observeRun(view, signal, accept, reconnect),
    create: (workspaceId: string, permission: ConversationPermission) =>
      request<Conversation>(workspaceRoute(workspaceId, '/sessions'), payload('POST', { permission })),
    setPermission: (id: string, permission: ConversationPermission) =>
      request<Conversation>('/sessions/' + id + '/permissions', payload('PATCH', { permission })),
    start: (id: string, input: { message: string; attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: string | null }) =>
      request<RunInfo>('/sessions/' + id + '/runs', payload('POST', input)),
    queue: (id: string, input: { message: string; mode: 'steer' | 'followUp';
      attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: string | null }) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue', payload('POST', input)),
    getQueue: (id: string, signal: AbortSignal) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue', { signal }),
    cancelQueue: (id: string, item?: string) =>
      request<ConversationView['queue']>('/sessions/' + id + '/queue' + (item ? '/' + encodeURIComponent(item) : ''), { method: 'DELETE' }),
    compact: (id: string) => request('/sessions/' + id + '/compact', payload('POST', {})),
    cancel: (id: string) => request('/sessions/' + id + '/cancel', payload('POST', {}))
  };
}
