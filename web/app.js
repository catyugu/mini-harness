const $ = (id) => document.getElementById(id);
const tokenFromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
if (tokenFromUrl) {
  sessionStorage.setItem('minih-token', tokenFromUrl);
  history.replaceState(null, '', location.pathname + location.search);
}
const token = sessionStorage.getItem('minih-token');
let state = { sessions: [], models: [], settings: null, active: null, selection: new Set(), selecting: false, expanded: new Set(), sending: false };

async function api(path, options = {}) {
  if (!token) throw new Error('No access token. Open minih using the URL printed by the CLI.');
  const headers = { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch('/api' + path, { ...options, headers });
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { data = {}; }
    throw new Error(data.error || 'Request failed (' + response.status + ')');
  }
  return response;
}
async function data(path, options) { return (await api(path, options)).json(); }
const post = (path, payload) => data(path, { method: 'POST', body: JSON.stringify(payload) });
function status(text) { $('status').textContent = text || ''; }
function sidebar(open) { $('sidebar').classList.toggle('open', open); $('overlay').classList.toggle('hidden', !open); }
function settings(open) { $('settingsPanel').classList.toggle('hidden', !open); if (open) fillSettings(); }
function appearance(value) { document.documentElement.dataset.theme = value; $('app').dataset.theme = value; }

async function refresh() {
  const result = await data('/bootstrap');
  state.sessions = result.sessions;
  state.settings = result.settings;
  state.models = result.models;
  appearance(state.settings.appearance);
  $('modelSelect').replaceChildren(new Option('Auto model', ''));
  for (const m of state.models) $('modelSelect').append(new Option(m.name + ' · ' + m.provider, m.provider + '/' + m.id));
  const selected = state.settings.model;
  $('modelSelect').value = selected.provider && selected.id ? selected.provider + '/' + selected.id : '';
  $('workspaceLabel').textContent = 'Local workspace';
  renderSessions();
}

function renderSessions() {
  const box = $('sessions');
  box.replaceChildren();
  const roots = state.sessions.filter((s) => !s.parentId);
  const add = (item, depth = 0) => {
    const row = document.createElement('div');
    row.className = 'session-row' + (depth ? ' child' : '') + (state.active === item.id ? ' active' : '');
    row.tabIndex = 0;
    const kids = state.sessions.filter((s) => s.parentId === item.id);
    if (kids.length) {
      const toggle = document.createElement('button');
      toggle.className = 'tree-button';
      toggle.textContent = state.expanded.has(item.id) ? '▾' : '▸';
      toggle.setAttribute('aria-label', 'Toggle children');
      toggle.onclick = (event) => { event.stopPropagation(); state.expanded.has(item.id) ? state.expanded.delete(item.id) : state.expanded.add(item.id); renderSessions(); };
      row.append(toggle);
    }
    if (state.selecting) {
      const box = document.createElement('input');
      box.type = 'checkbox'; box.checked = state.selection.has(item.id);
      box.setAttribute('aria-label', 'Select ' + item.title);
      box.onclick = (event) => event.stopPropagation();
      box.onchange = () => { box.checked ? state.selection.add(item.id) : state.selection.delete(item.id); updateSelection(); };
      row.append(box);
    }
    const title = document.createElement('span');
    title.className = 'name'; title.textContent = item.title;
    row.append(title);
    row.onclick = () => {
      if (state.selecting) {
        if (state.selection.has(item.id)) state.selection.delete(item.id); else state.selection.add(item.id);
        renderSessions(); return;
      }
      void activate(item.id);
    };
    row.onkeydown = (event) => { if (event.key === 'Enter') row.click(); };
    box.append(row);
    if (state.expanded.has(item.id)) for (const child of kids) add(child, depth + 1);
  };
  for (const root of roots) add(root);
  updateSelection();
}

function updateSelection() {
  $('bulkActions').classList.toggle('hidden', !state.selecting);
  $('selectedCount').textContent = state.selection.size + ' selected';
  $('exportSessions').disabled = !$('deleteSessions').disabled = state.selection.size === 0;
}

function addMessage(role, content) {
  const el = document.createElement('article');
  el.className = 'message ' + role;
  el.textContent = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
    : '';
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

async function activate(id) {
  if (state.sending) return;
  state.active = id;
  const result = await data('/sessions/' + id);
  $('messages').replaceChildren();
  for (const msg of result.messages) if (msg.role === 'user' || msg.role === 'assistant') addMessage(msg.role, msg.content);
  $('conversationTitle').textContent = result.title;
  $('welcome').classList.add('hidden');
  renderSessions();
  sidebar(false);
}

async function newSession() {
  if (state.sending) return;
  const record = await post('/sessions', {});
  state.sessions.unshift(record);
  state.active = record.id;
  $('messages').replaceChildren();
  $('welcome').classList.remove('hidden');
  $('conversationTitle').textContent = record.title;
  renderSessions();
  sidebar(false);
  $('prompt').focus();
}

async function send(message) {
  if (state.sending || !message.trim()) return;
  if (!state.active) await newSession();
  state.sending = true;
  $('send').disabled = true;
  $('welcome').classList.add('hidden');
  addMessage('user', message);
  const answer = addMessage('assistant', '');
  status('Thinking…');
  try {
    const response = await api('/sessions/' + state.active + '/messages', { method: 'POST', body: JSON.stringify({ message }) });
    if (!response.body) throw new Error('No response stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const processLine = (line) => {
      if (!line) return;
      const event = JSON.parse(line);
      if (event.type === 'delta') { answer.textContent += event.text; $('messages').scrollTop = $('messages').scrollHeight; }
      else if (event.type === 'complete') answer.textContent = event.text;
      else if (event.type === 'error') { status(event.error); answer.textContent += '\n' + event.error; }
      else if (event.type === 'tool') status('Using ' + event.name + '…');
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer.trim());
    const result = await data('/sessions');
    state.sessions = result;
    renderSessions();
    if (state.active) $('conversationTitle').textContent = state.sessions.find((s) => s.id === state.active)?.title || 'Conversation';
  } catch (error) { status(error.message); answer.textContent += '\n' + error.message; }
  finally { state.sending = false; $('send').disabled = false; if (!$('status').textContent.startsWith('Error')) status(''); $('prompt').focus(); }
}

function fillSettings() {
  const s = state.settings;
  $('theme').value = s.appearance;
  $('provider').value = s.model.provider;
  $('model').value = s.model.id;
  $('maxParallel').value = s.subagents.maxParallel;
  $('childProvider').value = s.subagents.provider;
  $('childModel').value = s.subagents.model;
  $('sandboxMode').value = s.sandbox.mode;
  $('timeout').value = s.sandbox.timeoutSeconds;
  for (const name of ['skills', 'subagents', 'shell']) $('plugin-' + name).checked = s.plugins[name];
  $('settingsStatus').textContent = '';
}

async function saveSettings() {
  const plugins = {};
  for (const name of ['skills', 'subagents', 'shell']) plugins[name] = $('plugin-' + name).checked;
  const patch = {
    appearance: $('theme').value,
    model: { provider: $('provider').value.trim(), id: $('model').value.trim() },
    plugins,
    subagents: { maxParallel: Number($('maxParallel').value), provider: $('childProvider').value.trim(), model: $('childModel').value.trim() },
    sandbox: { mode: $('sandboxMode').value, timeoutSeconds: Number($('timeout').value) }
  };
  try {
    state.settings = await data('/settings', { method: 'PATCH', body: JSON.stringify(patch) });
    appearance(state.settings.appearance);
    $('settingsStatus').textContent = 'Saved.';
    $('modelSelect').value = patch.model.provider && patch.model.id ? patch.model.provider + '/' + patch.model.id : '';
  } catch (error) { $('settingsStatus').textContent = error.message; }
}

async function exportSelected() {
  const response = await api('/sessions/export', { method: 'POST', body: JSON.stringify({ ids: [...state.selection] }) });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'minih-sessions.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function deleteSelected() {
  if (!confirm('Permanently delete ' + state.selection.size + ' selected conversation(s), including their child conversations?')) return;
  try {
    const result = await post('/sessions/delete', { ids: [...state.selection] });
    state.selection.clear();
    state.sessions = await data('/sessions');
    if (result.deleted.includes(state.active)) { state.active = null; $('messages').replaceChildren(); $('welcome').classList.remove('hidden'); $('conversationTitle').textContent = 'New conversation'; }
    renderSessions();
  } catch (error) { alert(error.message); }
}

$('sidebarOpen').onclick = () => sidebar(!$('sidebar').classList.contains('open'));
$('sidebarClose').onclick = () => sidebar(false);
$('overlay').onclick = () => sidebar(false);
$('settingsOpen').onclick = () => { settings(true); sidebar(false); };
$('settingsClose').onclick = () => settings(false);
$('newSession').onclick = () => void newSession();
$('selectMode').onclick = () => { state.selecting = !state.selecting; state.selection.clear(); renderSessions(); };
$('cancelSelection').onclick = () => { state.selecting = false; state.selection.clear(); renderSessions(); };
$('exportSessions').onclick = () => void exportSelected();
$('deleteSessions').onclick = () => void deleteSelected();
$('saveSettings').onclick = () => void saveSettings();
$('saveCredential').onclick = async () => {
  try {
    await post('/credentials', { provider: $('provider').value.trim(), key: $('apiKey').value });
    $('apiKey').value = '';
    $('settingsStatus').textContent = 'API key saved locally.';
  } catch (error) { $('settingsStatus').textContent = error.message; }
};
$('modelSelect').onchange = () => {
  const value = $('modelSelect').value;
  const i = value.indexOf('/');
  const patch = { model: { provider: i >= 0 ? value.slice(0, i) : '', id: i >= 0 ? value.slice(i + 1) : '' } };
  void data('/settings', { method: 'PATCH', body: JSON.stringify(patch) })
    .then((settings) => { state.settings = settings; })
    .catch((error) => status(error.message));
};
$('composer').onsubmit = (event) => {
  event.preventDefault();
  const message = $('prompt').value;
  $('prompt').value = '';
  $('prompt').style.height = '';
  void send(message);
};
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); $('composer').requestSubmit();
  }
};
$('prompt').oninput = () => { $('prompt').style.height = 'auto'; $('prompt').style.height = Math.min($('prompt').scrollHeight, 210) + 'px'; };

refresh().then(() => {
  if (state.sessions.length) void activate(state.sessions[0].id);
}).catch((error) => { status(error.message); $('welcome').classList.remove('hidden'); });
