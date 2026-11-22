import { api, data, readEvents } from './api.js';
import type { RunEvent, RunInfo } from '../src/protocol.js';
import { isRunning } from './session-projection.js';

function waitToReconnect(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function subscribeRun(run: RunInfo, signal: AbortSignal, receive: (event: RunEvent) => void, reconnecting: () => void) {
  const path = '/sessions/' + run.sessionId;
  let cursor = run.sequence;
  let ended = false;
  let retries = 0;
  while (!ended && !signal.aborted) {
    try {
      const response = await api(path + '/events?run=' + run.id + '&after=' + cursor, { signal });
      await readEvents<RunEvent>(response, (event) => {
        if (signal.aborted || event.sequence < cursor || (event.sequence === cursor && event.type !== 'snapshot')) return;
        cursor = event.sequence;
        if (event.type === 'snapshot' || event.type === 'run') ended = !isRunning(event.run);
        receive(event);
      });
    } catch {
      if (ended || signal.aborted) return;
    }
    if (ended || signal.aborted) return;
    reconnecting();
    await waitToReconnect(Math.min(5000, 500 * ++retries), signal);
    if (signal.aborted) return;
    try {
      const latest = await data<{ run?: RunInfo }>(path + '/runs', { signal });
      if (latest.run?.id !== run.id) return;
    } catch { /* The server may still be unreachable. */ }
  }
}
