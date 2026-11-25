import { DomainError } from '@mini-harness/platform/errors';
import { randomBytes } from 'node:crypto';
import type { ImageInput, PreparedMessage } from '@mini-harness/input/message';
import type { SessionLogPort, InboxItem } from '@mini-harness/sessions/log-api';
import type { QueueEntry } from '@mini-harness/sessions/queue';

/** Inbox acknowledgments and deliveries are committed to the same session log. */
export class Inbox {
  constructor(private readonly log: SessionLogPort) {}

  list() {
    return this.log.inbox();
  }
  view(): QueueEntry[] {
    return this.log.queue();
  }

  enqueue(
    mode: InboxItem['mode'],
    prepare: () => { text: string; images: ImageInput[]; input: PreparedMessage },
    options: Pick<InboxItem, 'model' | 'thinkingLevel'> = {},
  ) {
    if (mode !== 'steer' && mode !== 'followUp') throw new DomainError('invalid_input', 'Invalid queue mode');
    if (this.list().length >= 16) throw new DomainError('conflict', 'Queue is full');
    const prepared = prepare();
    this.log.append({
      type: 'inbox-enqueued',
      item: {
        id: randomBytes(16).toString('hex'),
        mode,
        text: prepared.text,
        images: prepared.images,
        input: prepared.input,
        ...options,
      },
    });
    return this.view();
  }

  next(mode: InboxItem['mode']) {
    return this.list().find((item) => item.mode === mode);
  }

  fail(item: InboxItem, error: unknown) {
    if (this.next(item.mode)?.id === item.id)
      this.log.append({
        type: 'inbox-failed',
        inboxId: item.id,
        reason: error instanceof Error ? error.message : String(error),
      });
  }

  select<T>(
    mode: InboxItem['mode'],
    select: (item: InboxItem) => T,
  ): { item: InboxItem; value: T } | undefined {
    for (const item of this.list()) {
      if (item.mode !== mode) continue;
      try {
        return { item, value: select(item) };
      } catch (error) {
        this.fail(item, error);
      }
    }
  }

  cancel(reason: string, id?: string) {
    const ids = this.list()
      .filter((item) => id === undefined || item.id === id)
      .map((item) => item.id);
    if (ids.length) this.log.append({ type: 'inbox-cancelled', ids, reason });
    return this.view();
  }
}
