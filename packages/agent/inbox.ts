import { randomBytes } from 'node:crypto';
import { prepareInput } from '@mini-harness/platform/input';
import type { Attachment } from '@mini-harness/contracts/input';
import type { SessionLogPort, InboxItem } from '@mini-harness/contracts/session-log';

/** Inbox acknowledgments and deliveries are committed to the same session log. */
export class Inbox {
  constructor(private readonly log: SessionLogPort) {}

  list() { return this.log.projection().inbox; }
  view() {
    const items = this.list();
    return {
      steer: items.filter((item) => item.mode === 'steer').map((item) => item.input?.userText || item.text),
      followUp: items.filter((item) => item.mode === 'followUp').map((item) => item.input?.userText || item.text)
    };
  }

  enqueue(text: string, mode: InboxItem['mode'], attachments?: Attachment[],
    options: Pick<InboxItem, 'model' | 'thinkingLevel'> = {}) {
    if (mode !== 'steer' && mode !== 'followUp') throw new Error('Invalid queue mode');
    if (this.list().length >= 16) throw new Error('Queue is full');
    const prepared = prepareInput(text, attachments);
    this.log.append({ type: 'inbox-enqueued', item: {
      id: randomBytes(16).toString('hex'), mode, text: prepared.text, images: prepared.images,
      input: prepared.input, ...options
    } });
    return this.view();
  }

  next(mode: InboxItem['mode']) { return this.list().find((item) => item.mode === mode); }

  cancel(reason: string) {
    const ids = this.list().map((item) => item.id);
    if (ids.length) this.log.append({ type: 'inbox-cancelled', ids, reason });
  }
}
