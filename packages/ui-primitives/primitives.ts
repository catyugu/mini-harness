import { icon } from './icons.js';

export function fromMarkup<T extends HTMLElement = HTMLElement>(markup: string): T {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as T;
}

export function closeOnBackdrop(dialog: HTMLDialogElement) {
  let startedOutside = false;
  const outside = (event: MouseEvent) => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX >= bounds.right ||
      event.clientY < bounds.top || event.clientY >= bounds.bottom);
  };
  dialog.addEventListener('pointerdown', (event) => { startedOutside = outside(event); });
  dialog.addEventListener('click', (event) => { if (startedOutside && outside(event)) dialog.close(); });
}

export function button(label: string, variant: 'primary' | 'secondary' | 'quiet' | 'danger' = 'secondary') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'ui-button';
  node.dataset.variant = variant;
  node.textContent = label;
  return node;
}

export function iconButton(label: string, name: Parameters<typeof icon>[0], className = 'icon-button') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.setAttribute('aria-label', label);
  node.title = label;
  node.append(icon(name));
  return node;
}

export function field(label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  const node = document.createElement('label');
  node.className = 'ui-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  node.append(caption, control);
  return node;
}

export function toggle(label: string, checked: boolean) {
  const node = document.createElement('input');
  node.type = 'checkbox';
  node.className = 'toggle';
  node.setAttribute('role', 'switch');
  node.setAttribute('aria-label', label);
  node.checked = checked;
  return node;
}

export function saveToggle(node: HTMLInputElement, save: (checked: boolean) => Promise<boolean>) {
  let checked = node.checked;
  node.addEventListener('change', async () => {
    if (node.disabled) return;
    const next = node.checked;
    const focused = document.activeElement === node;
    node.setAttribute('aria-busy', 'true');
    node.disabled = true;
    try {
      if (await save(next)) checked = next;
    } finally {
      node.checked = checked;
      node.disabled = false;
      node.removeAttribute('aria-busy');
      if (focused && document.activeElement === document.body) node.focus({ preventScroll: true });
    }
  });
}

export function dialog(title: string, content: HTMLElement) {
  const node = fromMarkup<HTMLDialogElement>(`<dialog class="ui-dialog">
    <header class="settings-header"><h2></h2><button type="button" class="icon-button"></button></header>
    <div class="ui-dialog-body"></div>
  </dialog>`);
  node.setAttribute('aria-label', title);
  required(node.querySelector('h2')).textContent = title;
  const close = required(node.querySelector('button'));
  close.append(icon('close'));
  close.setAttribute('aria-label', 'Close ' + title.toLowerCase());
  close.onclick = () => node.close();
  required(node.querySelector('.ui-dialog-body')).append(content);
  closeOnBackdrop(node);
  return node;
}

/** One accessible, app-styled confirmation instead of platform-specific window.confirm(). */
export function confirmAction(message: string, options: { title?: string; confirmLabel?: string; signal?: AbortSignal } = {}): Promise<boolean> {
  if (options.signal?.aborted) return Promise.resolve(false);
  const actions = document.createElement('form');
  actions.className = 'ui-confirm';
  actions.method = 'dialog';
  const text = document.createElement('p');
  text.textContent = message;
  const row = document.createElement('div');
  row.className = 'ui-actions';
  const cancel = button('Cancel', 'quiet');
  const confirm = button(options.confirmLabel ?? 'Delete', 'danger');
  confirm.type = 'submit';
  confirm.value = 'confirmed';
  cancel.onclick = () => modal.close();
  row.append(cancel, confirm);
  actions.append(text, row);
  const modal = dialog(options.title ?? 'Confirm deletion', actions);
  document.body.append(modal);
  return new Promise((resolve) => {
    const abort = () => modal.close();
    options.signal?.addEventListener('abort', abort, { once: true });
    modal.addEventListener('close', () => {
      options.signal?.removeEventListener('abort', abort);
      resolve(modal.returnValue === 'confirmed');
      modal.remove();
    }, { once: true });
    modal.showModal();
    cancel.focus();
  });
}

/** Assert that a node declared by a component's own static markup actually exists. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required UI element is missing');
  return value;
}
