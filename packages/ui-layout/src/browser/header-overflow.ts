import { bindPopover } from '@mini-harness/ui-primitives/primitives';

export function createHeaderOutlet(
  meta: HTMLElement,
  context: HTMLElement,
  actions: HTMLElement,
  row: HTMLElement,
  more: HTMLButtonElement,
  panel: HTMLElement,
  signal: AbortSignal,
) {
  let nodes: readonly HTMLElement[] = [];
  let frame = 0;
  bindPopover(more, panel, signal);

  function schedule() {
    if (frame || signal.aborted) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  function place(parent: HTMLElement, items: readonly HTMLElement[]) {
    items.forEach((node, index) => {
      const next = parent.children[index];
      if (next !== node) parent.insertBefore(node, next ?? null);
    });
  }

  function render() {
    const visible = nodes.filter((node) => !node.hidden);
    actions.hidden = visible.length === 0;
    if (!visible.length) {
      more.hidden = true;
      if (panel.matches(':popover-open')) panel.hidePopover();
      place(row, nodes);
      return;
    }
    const width = meta.clientWidth;
    if (!width) return;
    const gap = parseFloat(getComputedStyle(row).columnGap);
    // Keep a small amount of space for flexible context contributions.
    const reserved =
      context.hidden || !context.querySelector(':scope > :not([hidden])')
        ? 0
        : Math.min(64, width * 0.3) + gap;
    const available = width - reserved;
    const sizes = visible.map((node) => Math.ceil(node.getBoundingClientRect().width));
    const total = sizes.reduce((sum, size) => sum + size, 0) + gap * (sizes.length - 1);
    let count = visible.length;
    if (total > available) {
      const budget = available - parseFloat(getComputedStyle(more).width) - gap;
      count = 0;
      let used = 0;
      for (const size of sizes) {
        const next = used + (count ? gap : 0) + size;
        if (next > budget) break;
        used = next;
        count++;
      }
    }
    const overflow = visible.slice(count);
    const overflowed = new Set(overflow);
    if (!overflow.length && panel.matches(':popover-open')) panel.hidePopover();
    more.hidden = !overflow.length;
    place(
      row,
      nodes.filter((node) => !overflowed.has(node)),
    );
    place(panel, overflow);
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
  return (next: readonly HTMLElement[]) => {
    nodes = next;
    // Keep each mounted contribution measurable even while the overflow menu is closed.
    for (const node of nodes)
      if (node.parentElement !== row && node.parentElement !== panel) panel.append(node);
    resize.disconnect();
    visibility.disconnect();
    resize.observe(meta);
    visibility.observe(context, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
    for (const node of nodes) {
      resize.observe(node);
      visibility.observe(node, { attributes: true, attributeFilter: ['hidden'] });
    }
    schedule();
  };
}
