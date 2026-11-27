import { bindPopover, iconButton } from './primitives.ts';

let nextId = 0;

/** Mount one row of actions. The caller supplies the space left after its fixed controls. */
export function overflowActions(
  host: HTMLElement,
  label: string,
  signal: AbortSignal,
  space: HTMLElement = host,
  available = () => space.clientWidth,
) {
  const row = document.createElement('div');
  row.className = 'ui-row ui-action-items';
  const more = iconButton(label, 'ellipsis', 'ui-action-more');
  const menu = document.createElement('div');
  menu.id = 'action-overflow-' + ++nextId;
  menu.className = 'ui-popover ui-action-overflow';
  menu.popover = 'auto';
  menu.setAttribute('role', 'region');
  menu.setAttribute('aria-label', label);
  more.setAttribute('popovertarget', menu.id);
  more.setAttribute('aria-controls', menu.id);
  more.setAttribute('aria-expanded', 'false');
  more.hidden = true;
  host.classList.add('ui-row');
  host.append(row, more, menu);
  bindPopover(more, menu, signal, { align: 'end' });

  let items = new Map<HTMLElement, HTMLElement>();
  let frame = 0;
  function place(parent: HTMLElement, items: HTMLElement[]) {
    const container = parent as HTMLElement & { moveBefore?(node: HTMLElement, next: Element | null): void };
    items.forEach((node, index) => {
      const next = parent.children[index] ?? null;
      if (next === node) return;
      if (container.moveBefore && node.isConnected && parent.isConnected) container.moveBefore(node, next);
      else parent.insertBefore(node, next);
    });
  }

  function render() {
    const visible = [...items].filter(([node]) => !node.hidden).map(([, box]) => box);
    if (host.hidden !== !visible.length) host.hidden = !visible.length;
    const width = available();
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const sizes = visible.map((node) => node.getBoundingClientRect().width + gap);
    const total = sizes.reduce((sum, size) => sum + size, -gap);
    let count = visible.length;
    const focused = document.activeElement;
    const wasInGroup = focused instanceof HTMLElement && host.contains(focused);
    if (total > width) {
      if (more.hidden) more.hidden = false;
      const budget = width - more.offsetWidth;
      let used = 0;
      count = 0;
      for (const size of sizes) {
        if (used + size > budget) break;
        used += size;
        count++;
      }
    }
    const overflow = new Set(visible.slice(count));
    place(
      row,
      [...items.values()].filter((box) => !overflow.has(box)),
    );
    place(menu, [...overflow]);
    if (!overflow.size && menu.matches(':popover-open')) menu.hidePopover();
    if (more.hidden !== !overflow.size) more.hidden = !overflow.size;
    if (wasInGroup && focused instanceof HTMLElement) {
      const hidden = more.hidden && focused === more;
      const inaccessible = menu.contains(focused) && !menu.matches(':popover-open');
      if (hidden) row.querySelector<HTMLElement>('button, a[href], [tabindex]')?.focus();
      else if (inaccessible) more.focus();
      else if (document.activeElement !== focused) focused.focus();
    }
  }

  function schedule() {
    if (frame || signal.aborted) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  const resize = new ResizeObserver(schedule);
  const visibility = new MutationObserver(schedule);
  signal.addEventListener(
    'abort',
    () => {
      resize.disconnect();
      visibility.disconnect();
      cancelAnimationFrame(frame);
    },
    { once: true },
  );
  resize.observe(space);
  const visibilityOptions = { childList: true, subtree: true, attributeFilter: ['hidden'] };
  visibility.observe(space, visibilityOptions);
  if (!space.contains(host)) visibility.observe(host, visibilityOptions);
  return (nodes: readonly HTMLElement[]) => {
    if (signal.aborted) return;
    const next = new Map<HTMLElement, HTMLElement>();
    for (const node of nodes) {
      let box = items.get(node);
      if (!box) {
        box = document.createElement('div');
        box.className = 'ui-action-item';
        box.append(node);
        row.append(box);
        resize.observe(box);
      }
      next.set(node, box);
    }
    for (const [node, box] of items) {
      if (next.has(node)) continue;
      resize.unobserve(box);
      box.remove();
    }
    items = next;
    schedule();
  };
}
