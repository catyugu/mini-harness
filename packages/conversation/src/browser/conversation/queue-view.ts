import type { MessageMode } from '@mini-harness/sessions/queue';
import type { ConversationView } from '../../shared/api.ts';

export const modeLabel: Record<MessageMode, string> = {
  steer: 'Steer',
  interrupt: 'Interrupt',
  queue: 'Queue',
};

export function renderQueue(
  panel: HTMLElement,
  queue: readonly ConversationView['queue'][number][] = [],
  cancel: (id?: string) => void | Promise<void>,
) {
  panel.replaceChildren();
  let pendingCount = 0;
  for (const item of queue ?? []) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const label = document.createElement('span');
    label.textContent = modeLabel[item.mode] + ' · ' + item.summary;
    row.append(label);
    if (item.state === 'failed') {
      const reason = document.createElement('span');
      reason.textContent = item.reason ?? 'Could not deliver';
      reason.setAttribute('role', 'status');
      row.append(reason);
    } else {
      pendingCount++;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'small-button';
      button.textContent = 'Cancel';
      button.setAttribute('aria-label', 'Cancel queued message: ' + item.summary);
      button.onclick = () => void cancel(item.id);
      row.append(button);
    }
    panel.append(row);
  }
  if (pendingCount > 1) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'small-button';
    clear.textContent = 'Clear queue';
    clear.onclick = () => void cancel();
    panel.append(clear);
  }
  panel.hidden = !panel.childElementCount;
}
