import { scopedElements } from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import { fileCard, decodedSize, imageMime } from './attachment-card.js';
import type { ComposerCommand, ComposerModel, Suggestion } from '../composer-api.js';

export function createComposer(root: HTMLElement, model: ComposerModel, report: (error: Error) => void, signal: AbortSignal) {
  const { element } = scopedElements(root);
  const prompt = element<'textarea'>('prompt'), form = element<'form'>('composer');
  const attachmentList = element('attachments'), suggestions = element('suggestions');
  let completion: AbortController;
  let files: ReturnType<ComposerModel['draft']>['attachments'] | undefined;
  const render = (pending: boolean) => {
    const current = model.draft();
    element<'button'>('send').disabled = current.loading || current.awaitingAcceptance || pending;
    element<'button'>('queueSend').disabled = current.loading || current.awaitingAcceptance || pending;
    if (files?.length === current.attachments.length && files.every((file, index) => {
      const next = current.attachments[index];
      return file.name === next.name && file.mimeType === next.mimeType && file.data === next.data;
    })) return;
    files = current.attachments;
    attachmentList.replaceChildren(...files.map((file, index) => {
      const card = fileCard({ ...file, size: decodedSize(file.data) });
      card.classList.add('attachment');
      if (imageMime.test(file.mimeType)) {
        const image = document.createElement('img');
        image.src = 'data:' + file.mimeType + ';base64,' + file.data;
        image.alt = file.name;
        card.firstElementChild?.replaceWith(image);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button';
      remove.setAttribute('aria-label', 'Remove ' + file.name); remove.append(icon('close'));
      remove.onclick = () => model.removeAttachment(index); card.append(remove); return card;
    }));
    attachmentList.hidden = !files.length;
    prompt.required = !files.length;
  };
  const addFiles = (files: File[]) => model.addFiles(files).catch((error) => {
    if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error)));
  });
  form.addEventListener('dragover', (event) => { event.preventDefault(); form.classList.add('dragging'); });
  form.addEventListener('dragleave', () => form.classList.remove('dragging'));
  form.addEventListener('drop', (event) => { event.preventDefault(); form.classList.remove('dragging'); void addFiles([...(event.dataTransfer?.files ?? [])]); });
  prompt.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files ?? [])];
    if (images.length) { event.preventDefault(); void addFiles(images); }
  });
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
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
    if (marker !== '/' && !model.completer(marker)) return;
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
      try { void Promise.resolve(command.run()).catch(report); }
      catch (error) { report(error instanceof Error ? error : new Error(String(error))); }
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
      renderOptions(model.matchCommands(match.query).map((command) => ({
        label: '/' + command.name, group: command.group ?? 'Plugin', description: command.description,
        run: (complete) => useCommand(command, match, complete)
      })));
    } else {
      const provider = model.completer(match.kind);
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
    openFiles: () => input.click(),
    attachmentButton() {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
      button.setAttribute('aria-label', 'Attach files'); button.append(icon('attach')); button.onclick = () => input.click();
      return button;
    },
    refresh
  };
}
