import { icon } from './icons.ts';
import type { FloatingOptions } from './api.ts';

export function fromMarkup<T extends HTMLElement = HTMLElement>(markup: string): T {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as T;
}

/** Position an already visible floating surface relative to its anchor. */
export function positionFloating(anchor: HTMLElement, panel: HTMLElement, options: FloatingOptions = {}) {
  placeFloating(anchor.getBoundingClientRect(), viewportBounds(), panel, options);
}

function viewportBounds() {
  const viewport = window.visualViewport;
  return new DOMRectReadOnly(
    viewport?.offsetLeft ?? 0,
    viewport?.offsetTop ?? 0,
    viewport?.width ?? innerWidth,
    viewport?.height ?? innerHeight,
  );
}

function placeFloating(
  bounds: DOMRectReadOnly,
  { left, top, right, bottom }: DOMRectReadOnly,
  panel: HTMLElement,
  { width, maxHeight = 520, align = 'start', prefer = 'below' }: FloatingOptions,
) {
  const availableWidth = Math.max(0, right - left - 16);
  panel.style.maxWidth = availableWidth + 'px';
  if (width !== undefined) panel.style.width = Math.min(width, availableWidth) + 'px';
  panel.style.maxHeight = Math.max(0, Math.min(maxHeight, bottom - top - 16)) + 'px';
  const above = Math.max(0, bounds.top - top - 14);
  const below = Math.max(0, bottom - bounds.bottom - 14);
  const height = panel.offsetHeight;
  const placeBelow = prefer === 'below' ? height <= below || below >= above : height > above && below > above;
  panel.style.maxHeight = Math.min(maxHeight, placeBelow ? below : above) + 'px';
  const size = panel.getBoundingClientRect();
  const x = align === 'end' ? bounds.right - size.width : bounds.left;
  panel.style.left = Math.max(left + 8, Math.min(x, right - size.width - 8)) + 'px';
  panel.style.top = Math.max(top + 8, placeBelow ? bounds.bottom + 6 : bounds.top - size.height - 6) + 'px';
  panel.style.bottom = 'auto';
}

/** Bind positioning and expanded state to a native popover; callers own its content and actions. */
export function bindPopover(
  trigger: HTMLElement,
  panel: HTMLElement,
  signal: AbortSignal,
  options: FloatingOptions = {},
) {
  let frame = 0;
  let previousAnchor: DOMRectReadOnly | undefined;
  let previousViewport: DOMRectReadOnly | undefined;
  let previousPanel: number[] = [];
  const panelSize = () => [panel.offsetWidth, panel.offsetHeight, panel.scrollHeight];
  function sameBounds(previous: DOMRectReadOnly | undefined, current: DOMRectReadOnly) {
    return (
      previous?.x === current.x &&
      previous.y === current.y &&
      previous.width === current.width &&
      previous.height === current.height
    );
  }
  function position() {
    const anchor = trigger.getBoundingClientRect();
    if (
      (!anchor.width && !anchor.height) ||
      trigger.closest('[inert]') ||
      getComputedStyle(trigger).visibility !== 'visible'
    ) {
      panel.hidePopover();
      return false;
    }
    const viewport = viewportBounds();
    if (
      !sameBounds(previousAnchor, anchor) ||
      !sameBounds(previousViewport, viewport) ||
      panelSize().some((size, index) => size !== previousPanel[index])
    ) {
      placeFloating(anchor, viewport, panel, options);
      previousAnchor = anchor;
      previousViewport = viewport;
      // Placement can change the height cap. Compare against the resulting size.
      previousPanel = panelSize();
    }
    return true;
  }
  // Scrolling and sibling layout can move an anchor without resizing it.
  function follow() {
    if (panel.matches(':popover-open') && position()) frame = requestAnimationFrame(follow);
  }
  panel.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      panel.hidePopover();
      trigger.focus({ preventScroll: true });
    },
    { signal },
  );
  panel.addEventListener(
    'toggle',
    () => {
      cancelAnimationFrame(frame);
      const open = panel.matches(':popover-open');
      trigger.setAttribute('aria-expanded', String(open));
      if (open) {
        previousAnchor = undefined;
        follow();
      }
    },
    { signal },
  );
  signal.addEventListener(
    'abort',
    () => {
      cancelAnimationFrame(frame);
      if (panel.matches(':popover-open')) panel.hidePopover();
      trigger.setAttribute('aria-expanded', 'false');
    },
    { once: true },
  );
  return () => {
    // TS 5.9 predates the source option used for native popover nesting and focus.
    const surface = panel as HTMLElement & { showPopover(options: { source: HTMLElement }): void };
    surface.showPopover({ source: trigger });
    if (panel.matches(':popover-open')) {
      previousAnchor = undefined;
      position();
    }
  };
}

export function closeOnBackdrop(dialog: HTMLDialogElement) {
  let startedOutside = false;
  const outside = (event: MouseEvent) => {
    const bounds = dialog.getBoundingClientRect();
    return (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX >= bounds.right ||
        event.clientY < bounds.top ||
        event.clientY >= bounds.bottom)
    );
  };
  dialog.addEventListener('pointerdown', (event) => {
    startedOutside = outside(event);
  });
  dialog.addEventListener('click', (event) => {
    if (startedOutside && outside(event)) dialog.close();
  });
}

export function button(label: string, variant: 'primary' | 'secondary' | 'quiet' | 'danger' = 'secondary') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'ui-button';
  node.dataset.variant = variant;
  node.textContent = label;
  return node;
}

export function iconButton(label: string, name: Parameters<typeof icon>[0], className?: string) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className ? 'icon-button ' + className : 'icon-button';
  node.setAttribute('aria-label', label);
  node.title = label;
  node.append(icon(name));
  return node;
}

export function field(label: string | HTMLElement, control: HTMLElement, layout?: 'compact' | 'wide') {
  const node = document.createElement(
    control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
      ? 'label'
      : 'div',
  );
  node.className = layout ? 'ui-field ui-field-' + layout : 'ui-field';
  const caption = typeof label === 'string' ? document.createElement('span') : label;
  if (typeof label === 'string') caption.textContent = label;
  node.append(caption, control);
  return node;
}

export function toggle(label: string, checked: boolean) {
  const node = document.createElement('input');
  node.type = 'checkbox';
  node.name = label;
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
    <header class="ui-dialog-header"><h2></h2><button type="button" class="icon-button"></button></header>
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
export function confirmAction(
  message: string,
  options: { title?: string; confirmLabel?: string; signal?: AbortSignal } = {},
): Promise<boolean> {
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
    modal.addEventListener(
      'close',
      () => {
        options.signal?.removeEventListener('abort', abort);
        resolve(modal.returnValue === 'confirmed');
        modal.remove();
      },
      { once: true },
    );
    modal.showModal();
    cancel.focus();
  });
}

/** Assert that a node declared by a component's own static markup actually exists. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required UI element is missing');
  return value;
}

export function scopedElements(root: HTMLElement) {
  function element<K extends keyof HTMLElementTagNameMap = 'div'>(id: string): HTMLElementTagNameMap[K] {
    return (root.id === id ? root : root.querySelector('#' + id)) as HTMLElementTagNameMap[K];
  }
  return { element, value: (id: string) => element<'input'>(id).value.trim() };
}

/** A compact, neutral timeline row. Its content and actions belong to the caller. */
export function recordRow(title: string | HTMLElement, body: HTMLElement, trailing: HTMLElement[] = []) {
  const details = document.createElement('details');
  details.className = 'ui-record ui-disclosure';
  const summary = document.createElement('summary');
  const label = typeof title === 'string' ? document.createElement('span') : title;
  if (typeof title === 'string') label.textContent = title;
  label.classList.add('ui-record-label');
  body.classList.add('ui-record-body');
  summary.append(icon('chevron'), label, ...trailing);
  details.append(summary, body);
  return details;
}
