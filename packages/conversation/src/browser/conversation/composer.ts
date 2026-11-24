import { slotExtensions } from '@mini-harness/ui-slots/browser/api';
import { scopedElements } from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import type { CommandRegistry } from './commands.js';
import type { ComposerCommand, Completer, DraftMode, Suggestion } from '../composer-api.js';
import type { Attachment } from '@mini-harness/input/message';
import type { FrontendApi } from '@mini-harness/ui-runtime/frontend-api';
export interface ConversationDraft {
  text: string;
  attachments: (Attachment & { originalIndex?: number })[];
  revision?: DraftMode;
  loading: number;
  version: number;
}

export function createComposer(root: HTMLElement, draft: () => ConversationDraft, report: (error: Error) => void,
  commands: CommandRegistry, signal: AbortSignal) {
  const { element } = scopedElements(root);
  const prompt = element<'textarea'>('prompt'), form = element<'form'>('composer');
  const attachmentList = element('attachments'), suggestions = element('suggestions');
  const completions = new Map<string, Completer>();
  let completion: AbortController;
  const render = () => {
    const current = draft(), files = current.attachments;
    element<'button'>('send').disabled = current.loading > 0;
    element<'button'>('queueSend').disabled = current.loading > 0;
    attachmentList.replaceChildren(...files.map((file, index) => {
      const card = document.createElement('div'); card.className = 'attachment';
      if (file.mimeType.startsWith('image/')) { const image = document.createElement('img'); image.src = 'data:' + file.mimeType + ';base64,' + file.data; image.alt = file.name; card.append(image); }
      const name = document.createElement('span'); name.textContent = file.name; card.append(name);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button';
      remove.setAttribute('aria-label', 'Remove ' + file.name); remove.append(icon('close'));
      remove.onclick = () => { current.attachments.splice(index, 1); current.version++; render(); }; card.append(remove); return card;
    }));
    attachmentList.hidden = !files.length;
    prompt.required = !files.length;
  };
  const addFiles = async (incoming: File[]) => {
    const current = draft();
    const files = current.attachments;
    if (files.length + current.loading + incoming.length > 8) { report(new Error('Attach at most eight files')); return; }
    current.loading += incoming.length;
    current.version++;
    render();
    try {
      const added: Attachment[] = [];
      for (const file of incoming) {
        if (file.size > 6 * 1024 * 1024 || (!file.type.startsWith('image/') && file.size > 1024 * 1024)) throw new Error('Images: up to 6 MiB; UTF-8 text: up to 1 MiB');
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read ' + file.name)); reader.readAsDataURL(file);
        });
        added.push({ name: file.name, mimeType: file.type || 'text/plain', data });
      }
      if ([...files, ...added].reduce((total, file) => total + file.data.length * .75, 0) > 12 * 1024 * 1024)
        throw new Error('Attachments exceed 12 MiB per message');
      files.push(...added);
    } catch (error) {
      if (current === draft()) report(error instanceof Error ? error : new Error(String(error)));
    } finally {
      current.loading -= incoming.length;
      if (current === draft()) render();
    }
  };
  form.addEventListener('dragover', (event) => { event.preventDefault(); form.classList.add('dragging'); });
  form.addEventListener('dragleave', () => form.classList.remove('dragging'));
  form.addEventListener('drop', (event) => { event.preventDefault(); form.classList.remove('dragging'); void addFiles([...(event.dataTransfer?.files ?? [])]); });
  prompt.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files ?? [])];
    if (images.length) { event.preventDefault(); void addFiles(images); }
  });
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,text/*,.json,.csv,.md,.ts,.js,.py,.cpp,.h,.xml,.yaml,.yml,.log,.sql';
  input.onchange = () => { void addFiles([...(input.files ?? [])]); input.value = ''; };
  form.append(input);
  type Token = { start: number; end: number; query: string; kind: string };
  let token: Token | undefined;
  let completeSelected: (() => void)[] = [];
  let buttons: HTMLButtonElement[] = [], selected = -1;

  function currentToken(): Token | undefined {
    if (prompt.selectionStart !== prompt.selectionEnd) return;
    const cursor = prompt.selectionStart;
    const match = /(?:^|\s)([^\s\p{L}\p{N}])([^\s]*)$/u.exec(prompt.value.slice(0, cursor));
    if (!match) return;
    const [, marker, query] = match;
    if (marker !== '/' && !completions.has(marker)) return;
    const tail = /^\S*/.exec(prompt.value.slice(cursor))?.[0] ?? '';
    if (marker === '/' && !/^[\w:-]*$/.test(query + tail)) return;

    return { start: cursor - query.length - 1, end: cursor + tail.length, query, kind: marker as Token['kind'] };
  }

  function hide() {
    completion?.abort();
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

  function positionSuggestions() {
    if (suggestions.hidden) return;
    const bounds = form.getBoundingClientRect();
    const above = Math.max(0, bounds.top - 14);
    const below = Math.max(0, (window.visualViewport?.height ?? innerHeight) - bounds.bottom - 14);
    const openBelow = below > above && above < 230;
    suggestions.classList.toggle('suggestions-below', openBelow);
    suggestions.style.maxHeight = Math.min(285, openBelow ? below : above) + 'px';
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

  function renderOptions(entries: Suggestion[], index = 0, emptyText = '') {
    const scroll = suggestions.scrollTop;
    buttons = entries.map((entry, position) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.className = 'suggestion';
      button.id = 'input-option-' + position;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      const name = document.createElement('strong');
      name.textContent = entry.label;
      if (entry.icon) {
        button.classList.add('reference-option');
        button.style.setProperty('--file-depth', String(Math.min(entry.depth ?? 0, 8)));
        if (entry.expanded !== undefined) {
          const arrow = icon('chevron');
          arrow.classList.add('folder-chevron');
          if (entry.expanded) arrow.classList.add('expanded');
          button.setAttribute('aria-label', name.textContent + (entry.expanded ? ', collapse folder' : ', expand folder'));
          button.append(arrow);
        }
        button.append(icon(entry.icon));
      }
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
      button.onpointermove = () => highlight(position, false);
      button.onclick = () => entry.run();
      return button;
    });
    suggestions.replaceChildren(...buttons);
    if (!buttons.length && emptyText) {
      const hint = document.createElement('p');
      hint.className = 'suggestions-empty hint';
      hint.setAttribute('role', 'status');
      hint.textContent = emptyText;
      suggestions.append(hint);
    }
    suggestions.hidden = !buttons.length && !emptyText;
    completeSelected = entries.map((entry) => () => entry.run(true));
    selected = -1;
    highlight(buttons.length ? Math.min(index, buttons.length - 1) : -1, false);
    suggestions.scrollTop = scroll;
    positionSuggestions();
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
    } else {
      const provider = completions.get(match.kind);
      if (!provider) return;
      const controller = new AbortController();
      completion = controller;
      void Promise.resolve().then(() => provider({
        query: match.query,
        signal: controller.signal,
        show: (entries, emptyText) => {
          if (!controller.signal.aborted) renderOptions(entries, Math.max(selected, 0), emptyText);
        },
        replace: (text) => {
          if (!controller.signal.aborted) replace(text + (/^\s/.test(prompt.value.slice(match.end)) ? '' : ' '), match);
        }
      })).catch((error) => { if (!controller.signal.aborted) renderOptions([], 0, error.message); });
    }
  }

  prompt.addEventListener('input', () => { refresh(true); requestAnimationFrame(positionSuggestions); });
  window.addEventListener('resize', positionSuggestions, { signal });
  window.visualViewport?.addEventListener('resize', positionSuggestions, { signal });
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
  }, { signal });
  signal.addEventListener('abort', hide, { once: true });
  return {
    render,
    resetSuggestions: hide,
    attach(api: FrontendApi) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
      button.setAttribute('aria-label', 'Attach files'); button.append(icon('attach')); button.onclick = () => input.click(); api.contribute(slotExtensions.register, 'conversation.composer', button);
    },
    refresh,
    completion(trigger: string, complete: Completer) {
      if (trigger === '/' || !/^[!#$%&*?@^~]$/.test(trigger) || completions.has(trigger)) throw new Error('Invalid or duplicate completion trigger: ' + trigger);
      completions.set(trigger, complete);
      refresh(true);
      return () => { completions.delete(trigger); refresh(true); };
    }
  };
}
