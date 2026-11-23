export function scopedElements(root: HTMLElement) {
  function element<K extends keyof HTMLElementTagNameMap = 'div'>(id: string): HTMLElementTagNameMap[K] {
    return (root.id === id ? root : root.querySelector('#' + id)) as HTMLElementTagNameMap[K];
  }
  return { element, value: (id: string) => element<'input'>(id).value.trim() };
}
/** A hash-only navigation does not reload ESM modules. Recover by reloading with the new credential. */
function acceptTokenFromUrl() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) return false;
  const changed = sessionStorage.getItem('mini-harness-token') !== token;
  sessionStorage.setItem('mini-harness-token', token);
  history.replaceState(null, '', location.pathname + location.search);
  return changed;
}
acceptTokenFromUrl();
window.addEventListener('hashchange', () => {
  if (acceptTokenFromUrl()) location.reload();
});

export class AuthenticationError extends Error {
  constructor() { super('Session authorization expired. Restart mini-harness and open the new URL printed by the CLI.'); }
}
export async function api(path: string, options: RequestInit = {}) {
  const token = sessionStorage.getItem('mini-harness-token');
  if (!token) throw new Error('Open mini-harness using the URL printed by the CLI.');
  const headers = { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch('/api' + path, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) throw new AuthenticationError();
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Request failed (' + response.status + ')');
  }
  return response;
}
export async function data<T>(path: string, options?: RequestInit): Promise<T> { return (await api(path, options)).json(); }
export const payload = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

export const workspaceRoute = (id: string, resource = '') => '/workspaces/' + encodeURIComponent(id) + resource;

export async function readEvents<T>(response: Response, accept: (event: T) => void) {
  if (!response.body) throw new Error('No response stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) accept(JSON.parse(line));
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
