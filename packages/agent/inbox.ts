import { HttpError } from '@mini-harness/contracts/routes';
import { randomBytes } from 'node:crypto';
import { prepareInput } from '@mini-harness/contracts/input-node';
import type { Attachment } from '@mini-harness/contracts/input';
import type { SessionLogPort, InboxItem, QueueEntry } from '@mini-harness/contracts/session-log';

/** Inbox acknowledgments and deliveries are committed to the same session log. */
export class Inbox {
  constructor(private readonly log: SessionLogPort) {}

  list() { return this.log.inbox(); }
  view(): QueueEntry[] { return this.log.queue(); }

  enqueue(text: string, mode: InboxItem['mode'], attachments?: Attachment[],
    options: Pick<InboxItem, 'model' | 'thinkingLevel'> = {}) {
    if (mode !== 'steer' && mode !== 'followUp') throw new HttpError('invalid_input', 'Invalid queue mode');
    if (this.list().length >= 16) throw new HttpError('conflict', 'Queue is full');
    const prepared = prepareInput(text, attachments);
    this.log.append({ type: 'inbox-enqueued', item: {
      id: randomBytes(16).toString('hex'), mode, text: prepared.text, images: prepared.images,
      input: prepared.input, ...options
    } });
    return this.view();
  }

  next(mode: InboxItem['mode']) { return this.list().find((item) => item.mode === mode); }

  cancel(reason: string, id?: string) {
    const ids = this.list().filter((item) => id === undefined || item.id === id).map((item) => item.id);
    if (ids.length) this.log.append({ type: 'inbox-cancelled', ids, reason });
    return this.view();
  }
}
