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
