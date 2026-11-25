/** Place a composer picker next to its trigger within the visible viewport. */
export function positionPicker(
  button: HTMLButtonElement,
  popup: HTMLElement,
  preferredWidth: number,
  maxHeight = 420,
) {
  if (!popup.matches(':popover-open')) return;
  const anchor = button.getBoundingClientRect(),
    viewport = window.visualViewport;
  const width = Math.min(preferredWidth, (viewport?.width ?? innerWidth) - 16);
  const top = viewport?.offsetTop ?? 0,
    left = viewport?.offsetLeft ?? 0;
  const right = left + (viewport?.width ?? innerWidth),
    bottom = top + (viewport?.height ?? innerHeight);
  const above = anchor.top - top - 14,
    below = bottom - anchor.bottom - 14;
  popup.style.width = width + 'px';
  popup.style.left = Math.max(left + 8, Math.min(anchor.right - width, right - width - 8)) + 'px';
  popup.style.maxHeight = Math.min(maxHeight, bottom - top - 16, Math.max(above, below)) + 'px';
  popup.style.top = below > above ? Math.max(top + 8, anchor.bottom + 6) + 'px' : 'auto';
  popup.style.bottom = below > above ? 'auto' : innerHeight - Math.min(bottom - 8, anchor.top - 6) + 'px';
}
