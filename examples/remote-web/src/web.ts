import type { FrontendApi } from 'mini-harness/browser-plugin';

export default async function setup(_ctx: unknown, api: FrontendApi) {
  const root = document.createElement('section');
  root.className = 'remote-web';
  const open = api.ui.button('Create pairing link', 'primary');
  const status = api.ui.status('');
  const pair = document.createElement('figure');
  const devices = document.createElement('ul');
  devices.setAttribute('aria-label', 'Paired devices');
  root.append(open, status, pair, devices);
  const base = '/extensions/remote-web';
  let version = 0;
  async function refresh() {
    const revision = ++version;
    const snapshot = await api.request<{ origin: string; devices: { id: string; expiresAt: number }[] }>(base + '/devices');
    if (revision !== version || api.signal.aborted) return;
    status.textContent = snapshot.devices.length ? snapshot.origin : 'No paired devices';
    devices.replaceChildren(...snapshot.devices.map(({ id, expiresAt }) => {
      const entry = document.createElement('li');
      const remove = api.ui.button('Revoke', 'danger');
      remove.onclick = async () => {
        remove.disabled = true;
        try { await api.request(base + '/device?id=' + encodeURIComponent(id), { method: 'DELETE' }); }
        catch (error) { status.textContent = String(error); remove.disabled = false; }
      };
      entry.append('Device ' + id.slice(0, 8) + ' · Expires ' + new Date(expiresAt).toLocaleString(api.locale.current()), remove);
      return entry;
    }));
  }
  open.onclick = async () => {
    open.disabled = true;
    try {
      const { url, qr } = await api.request<{ url: string; qr: string }>(base + '/pair', { method: 'POST' });
      const image = document.createElement('img');
      image.alt = 'Pairing link QR code';
      image.src = 'data:image/svg+xml,' + encodeURIComponent(qr);
      const link = document.createElement('a');
      link.href = url;
      link.textContent = 'Open pairing link';
      pair.replaceChildren(image, link);
      status.textContent = 'This pairing link is valid for two minutes.';
    } catch (error) { status.textContent = String(error); }
    finally { open.disabled = false; }
  };
  api.page('devices', { title: 'Remote Web', content: root });
  api.watch(refresh);
  api.locale.subscribe(() => { void refresh(); });
  try { await refresh(); } catch { root.replaceChildren(api.ui.status('Manage paired devices from the local instance.')); }
}
