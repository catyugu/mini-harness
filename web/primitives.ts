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

export function dialog(title: string, content: HTMLElement) {
  const node = fromMarkup<HTMLDialogElement>(`<dialog class="ui-dialog">
    <header class="settings-header"><h2></h2><button type="button" class="icon-button"></button></header>
    <div class="ui-dialog-body"></div>
  </dialog>`);
  node.setAttribute('aria-label', title);
  node.querySelector('h2').textContent = title;
  const close = node.querySelector('button');
  close.append(icon('close'));
  close.setAttribute('aria-label', 'Close ' + title.toLowerCase());
  close.onclick = () => node.close();
  node.querySelector('.ui-dialog-body').append(content);
  closeOnBackdrop(node);
  return node;
}
