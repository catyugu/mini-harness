import type { RunEvent, RunInfo } from '#mini-harness/contracts/transport.js';
import { api, data, payload, readEvents, wait } from '../api.js';
import type { ConversationView } from '../types.js';

export const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running';
export const readConversation = (id: string, signal: AbortSignal) => data<ConversationView>('/sessions/' + id, { signal });

export async function observeRun(item: ConversationView, signal: AbortSignal, accept: (event: RunEvent) => void, reconnect: () => void) {
  const originalRun = item.run;
  if (!originalRun) throw new Error('Cannot observe a conversation without a run');
  const url = '/sessions/' + item.id + '/events?run=' + originalRun.id + '&after=';
  let cursor = originalRun.sequence, retries = 0, ended = false;
  while (!signal.aborted && !ended) {
    try {
      const response = await api(url + cursor, { signal });
      await readEvents<RunEvent>(response, (event) => {
        if (signal.aborted || event.sequence <= cursor && event.type !== 'snapshot') return;
        cursor = event.sequence;
        accept(event);
        if (event.type === 'run' || event.type === 'snapshot') ended = !isRunning(event.run);
      });
      if (!ended) throw new Error('Connection closed');
    } catch {
      if (signal.aborted) return;
      reconnect();
      await wait(Math.min(5000, 500 * ++retries), signal);
      if (signal.aborted) return;
      try {
        const latest = await readConversation(item.id, signal);
        if (latest.run?.id !== originalRun.id || !isRunning(latest.run)) return latest;
      } catch { /* Retry while the conversation remains selected. */ }
    }
  }
  if (!signal.aborted) return readConversation(item.id, signal);
}

export async function exportSessions(ids: string[], signal: AbortSignal) {
  const response = await api('/sessions/export', { ...payload('POST', { ids }), signal });
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'mini-harness-sessions.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
