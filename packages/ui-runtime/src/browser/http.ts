export class AuthenticationError extends Error {
  constructor() {
    super('Session authorization expired. Open the current URL printed by mini-harness.');
  }
}
export async function api(path: string, options: RequestInit = {}) {
  const token = sessionStorage.getItem('mini-harness-token');
  if (!token) throw new Error('Open mini-harness using the URL printed by the CLI.');
  const headers = new Headers(options.headers);
  headers.set('Authorization', 'Bearer ' + token);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) throw new AuthenticationError();
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Request failed (' + response.status + ')');
  }
  return response;
}
export async function data<T>(path: string, options?: RequestInit): Promise<T> {
  return (await api(path, options)).json();
}
export const payload = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

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
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) accept(JSON.parse(line));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
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

/** Authenticated request cancelled with both the caller and its UI plugin. */
export function browserRequest<T>(
  ctx: import('mini-harness/cordis').Context,
  path: string,
  options?: RequestInit,
) {
  const lifetime = ctx.fiber.signal;
  return data<T>(path, {
    ...options,
    signal: options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime,
  });
}
