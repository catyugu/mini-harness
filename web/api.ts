export function element<K extends keyof HTMLElementTagNameMap = 'div'>(id: string): HTMLElementTagNameMap[K] {
  return document.getElementById(id) as HTMLElementTagNameMap[K];
}
export const value = (id: string) => element<'input'>(id).value.trim();
const tokenFromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
if (tokenFromUrl) {
  sessionStorage.setItem('mini-harness-token', tokenFromUrl);
  history.replaceState(null, '', location.pathname + location.search);
}
let workspace: string;
export function setWorkspace(path: string) { workspace = path; }
export async function api(path: string, options: RequestInit = {}) {
  const token = sessionStorage.getItem('mini-harness-token');
  if (!token) throw new Error('Open mini-harness using the URL printed by the CLI.');
  const headers = { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(workspace ? { 'X-Workspace': encodeURIComponent(workspace) } : {}) };
  const response = await fetch('/api' + path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Request failed (' + response.status + ')');
  }
  return response;
}
export async function data<T>(path: string, options?: RequestInit): Promise<T> { return (await api(path, options)).json(); }
export const payload = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
