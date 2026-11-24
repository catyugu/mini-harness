import type { ThinkingLevel } from '@mini-harness/llm/vocabulary';
import { scopedElements } from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import { positionPicker } from './picker-position.js';

const labels: Record<ThinkingLevel, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'Extra high', max: 'Max'
};

export function createThinkingPicker(root: HTMLElement, onSelect: (level: ThinkingLevel | null) => void, signal: AbortSignal) {
  const { element } = scopedElements(root);
  const button = element<'button'>('thinkingLevel'), popup = element('thinkingPicker'), results = element('thinkingResults');
  let options: HTMLButtonElement[] = [];

  function position() { positionPicker(button, popup, 180, 320); }

  function open() {
    if (button.hidden || popup.matches(':popover-open')) return;
    popup.showPopover();
    position();
    (options.find((option) => option.getAttribute('aria-selected') === 'true') ?? options[0])?.focus();
  }

  button.onclick = () => { if (popup.matches(':popover-open')) popup.hidePopover(); else open(); };
  button.onkeydown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open();
  };
  popup.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      popup.hidePopover();
      button.focus();
      return;
    }
    if (!options.length) return;
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      options[(index + offset + options.length) % options.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
    }
  };
  popup.addEventListener('toggle', () => button.setAttribute('aria-expanded', String(popup.matches(':popover-open'))), { signal });
  window.addEventListener('resize', position, { signal });
  window.visualViewport?.addEventListener('resize', position, { signal });

  return {
    update(levels: ThinkingLevel[], desired: ThinkingLevel | null | undefined) {
      const selected = desired && levels.includes(desired) ? desired : null;
      const label = selected ? labels[selected] : 'Default';
      const text = document.createElement('span');
      text.textContent = label;
      button.replaceChildren(text, icon('chevron'));
      button.title = 'Thinking level: ' + label;
      button.setAttribute('aria-label', 'Thinking level: ' + label);
      button.hidden = levels.length < 2;
      if (button.hidden && popup.matches(':popover-open')) popup.hidePopover();

      const entries: Array<{ value: ThinkingLevel | null; label: string }> = [
        { value: null, label: 'Default' }, ...levels.map((value) => ({ value, label: labels[value] }))
      ];
      options = entries.map(({ value, label }) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'suggestion model-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(value === selected));
        const content = document.createElement('span');
        content.className = 'model-option-label';
        const title = document.createElement('strong');
        title.textContent = label;
        content.append(title);
        option.append(content);
        option.onclick = () => { popup.hidePopover(); onSelect(value); button.focus(); };
        return option;
      });
      results.replaceChildren(...options);
    }
  };
}
