import { element, data, payload } from './api.js';
import { icon } from './icons.js';
import type { Attachment } from '../src/input.js';
import type { FrontendApi } from './extensions.js';
export function createComposer(report: (error: Error) => void) {
  const prompt = element<'textarea'>('prompt'), form = element<'form'>('composer');
  const attachmentList = element('attachments'), suggestions = element('suggestions');
  let files: Attachment[] = [], loading = 0, generation = 0, draftGeneration = 0, timer: ReturnType<typeof setTimeout>;
  let skills: { name: string; description: string }[] = [], fileReferences = false;
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
  const insertSuggestion = (text: string, match: RegExpMatchArray) => {
    prompt.setRangeText(text, match.index, prompt.selectionStart, 'end'); suggestions.hidden = true; prompt.focus(); prompt.dispatchEvent(new Event('input'));
  };
  prompt.addEventListener('input', () => {
    clearTimeout(timer); const current = ++generation;
    const text = prompt.value.slice(0, prompt.selectionStart);
    const skill = text.match(/^\/(?:skill:)?([\w-]*)$/);
    const file = text.match(/@([^\s@]*)$/);
    if ((!skill || !skills.length) && (!file || !fileReferences)) { suggestions.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const entries = skill ? skills.filter((s) => s.name.includes(skill[1])).map((s) => ({ label: s.name, hint: s.description, insert: '/skill:' + s.name + ' ' })) :
          (await data<string[]>('/files/search?q=' + encodeURIComponent(file[1]))).map((path) => ({ label: path, hint: '', insert: '@' + JSON.stringify(path) + ' ' }));
        if (current !== generation) return;
        suggestions.replaceChildren(...entries.slice(0, 12).map((entry) => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'suggestion'; button.textContent = entry.label; button.title = entry.hint;
          button.onmousedown = (event) => event.preventDefault(); button.onclick = () => insertSuggestion(entry.insert, skill ?? file); return button;
        })); suggestions.hidden = !entries.length;
      } catch (error) { suggestions.hidden = true; report(error); }
    }, 150);
  });
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') suggestions.hidden = true;
    if (!suggestions.hidden && event.key === 'ArrowDown') { event.preventDefault(); suggestions.querySelector('button')?.focus(); }
  });
  suggestions.onkeydown = (event) => {
    if (event.key === 'Escape') { suggestions.hidden = true; prompt.focus(); }
    const buttons = [...suggestions.querySelectorAll('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
  };
  return {
    attachments: () => { if (loading) throw new Error('Files are still loading'); return structuredClone(files); },
    clear: () => { files = []; ++generation; ++draftGeneration; render(); suggestions.hidden = true; },
    attach(api: FrontendApi) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
      button.setAttribute('aria-label', 'Attach files'); button.append(icon('attach')); button.onclick = () => input.click(); api.mount('composer', button);
    },
    async skills(api: FrontendApi) {
      skills = await data('/skills');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button'; button.setAttribute('aria-label', 'Choose skill'); button.append(icon('skills'));
      button.onclick = () => { prompt.value = '/'; prompt.focus(); prompt.dispatchEvent(new Event('input')); };
      api.mount('composer', button); api.onDispose(() => { skills = []; suggestions.hidden = true; });
    },
    references(api: FrontendApi) { fileReferences = true; api.onDispose(() => { fileReferences = false; suggestions.hidden = true; }); }
  };
}
