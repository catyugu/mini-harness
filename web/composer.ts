import { element, data } from './api.js';
import { icon } from './icons.js';
import type { CommandRegistry, ComposerCommand } from './commands.js';
import type { Attachment } from '../src/input.js';
import type { FrontendApi } from './extensions.js';
export function createComposer(report: (error: Error) => void, commands: CommandRegistry) {
  const prompt = element<'textarea'>('prompt'), form = element<'form'>('composer');
  const attachmentList = element('attachments'), suggestions = element('suggestions');
  let files: Attachment[] = [], loading = 0, generation = 0, draftGeneration = 0, timer: ReturnType<typeof setTimeout>;
  let fileReferences = false;
  const render = () => {
    attachmentList.replaceChildren(...files.map((file, index) => {
      const card = document.createElement('div'); card.className = 'attachment';
      if (file.mimeType.startsWith('image/')) { const image = document.createElement('img'); image.src = 'data:' + file.mimeType + ';base64,' + file.data; image.alt = file.name; card.append(image); }
      const name = document.createElement('span'); name.textContent = file.name; card.append(name);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button';
      remove.setAttribute('aria-label', 'Remove ' + file.name); remove.append(icon('close'));
      remove.onclick = () => { files.splice(index, 1); render(); }; card.append(remove); return card;
    }));
    attachmentList.hidden = !files.length;
    prompt.required = !files.length;
  };
  const addFiles = async (incoming: File[]) => {
    if (files.length + loading + incoming.length > 8) { report(new Error('Attach at most eight files')); return; }
    const current = draftGeneration; loading += incoming.length;
    element<'button'>('send').disabled = true;
    try {
      const added: Attachment[] = [];
      for (const file of incoming) {
        if (file.size > 6 * 1024 * 1024 || (!file.type.startsWith('image/') && file.size > 1024 * 1024)) throw new Error('Images: up to 6 MiB; UTF-8 text: up to 1 MiB');
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read ' + file.name)); reader.readAsDataURL(file);
        });
        added.push({ name: file.name, mimeType: file.type || 'text/plain', data });
      }
      if (current === draftGeneration) {
        if ([...files, ...added].reduce((total, file) => total + file.data.length * .75, 0) > 12 * 1024 * 1024) throw new Error('Attachments exceed 12 MiB per message');
        files.push(...added); render();
      }
    } catch (error) { report(error); }
    finally { loading -= incoming.length; element<'button'>('send').disabled = loading > 0; }
  };
  form.addEventListener('dragover', (event) => { event.preventDefault(); form.classList.add('dragging'); });
  form.addEventListener('dragleave', () => form.classList.remove('dragging'));
  form.addEventListener('drop', (event) => { event.preventDefault(); form.classList.remove('dragging'); void addFiles([...event.dataTransfer.files]); });
  prompt.addEventListener('paste', (event) => {
    const images = [...event.clipboardData.files];
    if (images.length) { event.preventDefault(); void addFiles(images); }
  });
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,text/*,.json,.csv,.md,.ts,.js,.py,.cpp,.h,.xml,.yaml,.yml,.log,.sql';
  input.onchange = () => { void addFiles([...input.files]); input.value = ''; };
  form.append(input);
  type Token = { start: number; end: number; query: string; kind: '/' | '@' };
  let token: Token;
  let completeSelected: (() => void)[] = [];
  let buttons: HTMLButtonElement[] = [], selected = -1;

  function currentToken(): Token | undefined {
    if (prompt.selectionStart !== prompt.selectionEnd) return;
    const cursor = prompt.selectionStart;
    const match = /(?:^|\s)([\/@])([^\s\/@]*)$/.exec(prompt.value.slice(0, cursor));
    if (!match) return;
    const [, marker, query] = match;
    const tail = /^\S*/.exec(prompt.value.slice(cursor))[0];
    if (marker === '/' && !/^[\w:-]*$/.test(query + tail)) return;
    return { start: cursor - query.length - 1, end: cursor + tail.length, query, kind: marker as Token['kind'] };
  }

  function hide() {
    clearTimeout(timer);
    ++generation;
    token = undefined;
    completeSelected = [];
    buttons = [];
    selected = -1;
    suggestions.hidden = true;
    prompt.removeAttribute('aria-activedescendant');
  }

  function replace(text: string, match: Token) {
    prompt.setRangeText(text, match.start, match.end, 'end');
    hide();
    prompt.focus();
    prompt.dispatchEvent(new Event('input'));
  }

  function useCommand(command: ComposerCommand, match: Token, complete = false) {
    if (command.run && !complete) {
      replace('', match);
      void Promise.resolve().then(command.run).catch(report);
    } else {
      const space = !complete && !/^\s/.test(prompt.value.slice(match.end)) ? ' ' : '';
      replace('/' + command.name + space, match);
      if (!complete) hide();
    }
  }

  function highlight(index: number, scroll = true) {
    buttons[selected]?.setAttribute('aria-selected', 'false');
    selected = index;
    const item = buttons[index];
    if (!item) { prompt.removeAttribute('aria-activedescendant'); return; }
    item.setAttribute('aria-selected', 'true');
    prompt.setAttribute('aria-activedescendant', item.id);
    if (scroll) item.scrollIntoView({ block: 'nearest' });
  }

  function renderOptions(entries: { label: string; description?: string; group?: string; run: (complete?: boolean) => void }[]) {
    buttons = entries.map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.className = 'suggestion';
      button.id = 'input-option-' + index;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      const name = document.createElement('strong');
      name.textContent = entry.label;
      button.append(name);
      if (entry.group) {
        const group = document.createElement('small');
        group.className = 'suggestion-group';
        group.textContent = entry.group;
        button.append(group);
      }
      if (entry.description) {
        const detail = document.createElement('small');
        detail.className = 'suggestion-description';
        detail.textContent = entry.description;
        button.append(detail);
      }
      button.onmousedown = (event) => event.preventDefault();
      button.onpointermove = () => highlight(index, false);
      button.onclick = () => entry.run();
      return button;
    });
    suggestions.replaceChildren(...buttons);
    suggestions.hidden = !buttons.length;
    completeSelected = entries.map((entry) => () => entry.run(true));
    selected = -1;
    highlight(buttons.length ? 0 : -1, false);
  }

  function refresh(force = false) {
    const match = currentToken();
    if (!force && token && match && token.start === match.start && token.end === match.end && token.query === match.query && token.kind === match.kind) return;
    hide();
    if (!match) return;
    token = match;
    if (match.kind === '/') {
      renderOptions(commands.match(match.query).map((command) => ({
        label: '/' + command.name, group: command.group ?? 'Plugin', description: command.description,
        run: (complete) => useCommand(command, match, complete)
      })));
    } else if (fileReferences) {
      const current = generation;
      timer = setTimeout(async () => {
        try {
          const paths = await data<string[]>('/files/search?q=' + encodeURIComponent(match.query));
          if (current !== generation) return;
          renderOptions(paths.slice(0, 12).map((path) => ({
            label: path, run: () => replace('@' + JSON.stringify(path) + ' ', match)
          })));
        } catch (error) { if (current === generation) { hide(); report(error); } }
      }, 150);
    }
  }

  prompt.addEventListener('input', () => refresh(true));
  prompt.addEventListener('click', () => refresh(true));
  prompt.addEventListener('keyup', (event) => {
    if (!suggestions.hidden && buttons.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) refresh();
  });
  prompt.addEventListener('keydown', (event) => {
    if (event.isComposing || suggestions.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); return; }
    if (!buttons.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight((selected + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length);
    } else if (!event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      if (event.key === 'Tab') completeSelected[selected]?.();
      else buttons[selected]?.click();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target !== prompt && !suggestions.contains(event.target as Node)) hide();
  });
  return {
    attachments: () => { if (loading) throw new Error('Files are still loading'); return structuredClone(files); },
    clear: () => { files = []; ++draftGeneration; render(); hide(); },
    attach(api: FrontendApi) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
      button.setAttribute('aria-label', 'Attach files'); button.append(icon('attach')); button.onclick = () => input.click(); api.mount('composer', button);
    },
    async skills(api: FrontendApi) {
      const skills = await data<{ name: string; description: string }[]>('/skills');
      for (const skill of skills) api.command({ name: 'skill:' + skill.name, description: skill.description, group: 'Skill' });
      if (!skills.length) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-button';
      button.setAttribute('aria-label', 'Choose skill');
      button.append(icon('skills'));
      button.onclick = () => {
        const prefix = prompt.value.slice(0, prompt.selectionStart);
        api.insert((prefix && !/\s$/.test(prefix) ? ' ' : '') + '/skill:');
      };
      api.mount('composer', button);
      api.onDispose(hide);
    },
    refresh,
    references(api: FrontendApi) { fileReferences = true; api.onDispose(() => { fileReferences = false; hide(); }); }
  };
}
