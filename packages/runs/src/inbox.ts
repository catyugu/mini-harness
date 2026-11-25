import { DomainError } from '@mini-harness/platform/errors';
import { randomBytes } from 'node:crypto';
import type { ImageInput, PreparedMessage } from '@mini-harness/input/message';
import type { SessionLogPort, InboxItem } from '@mini-harness/sessions/log-api';
import type { ModelCatalogPort } from '@mini-harness/models/api';
import { validateModelOptions } from '@mini-harness/llm/options';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import { selectModel } from '@mini-harness/models/selection';
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
    models: ModelCatalogPort,
    options: Pick<InboxItem, 'model' | 'thinkingLevel'> & { fallback?: ModelChoice } = {},
  ) {
    if (mode !== 'steer' && mode !== 'followUp') throw new DomainError('invalid_input', 'Invalid queue mode');
    if (this.list().length >= 16) throw new DomainError('conflict', 'Queue is full');
    validateModelOptions(options.model, options.thinkingLevel);
    const { model } = selectModel(models, {
      explicit: options.model,
      stored: this.log.projection().model,
      fallback: options.fallback,
      preferStored: true,
      thinkingLevel: options.thinkingLevel,
    });
    const prepared = prepare();
    this.log.append({
      type: 'inbox-enqueued',
      item: {
        id: randomBytes(16).toString('hex'),
        mode,
        text: prepared.text,
        images: prepared.images,
        input: prepared.input,
        model,
        thinkingLevel: options.thinkingLevel,
      },
    });
    return this.view();
  }

  next(mode: InboxItem['mode']) {
    return this.list().find((item) => item.mode === mode);
  }

  private fail(item: InboxItem, error: unknown) {
    if (this.next(item.mode)?.id === item.id)
      this.log.append({
        type: 'inbox-failed',
        inboxId: item.id,
        reason: error instanceof Error ? error.message : String(error),
      });
  }

  hasValid(mode: InboxItem['mode'], validate: (item: InboxItem) => unknown) {
    for (let item = this.next(mode); item; item = this.next(mode)) {
      try {
        validate(item);
        return true;
      } catch (error) {
        this.fail(item, error);
      }
    }
    return false;
  }

  async deliver<P>(
    mode: InboxItem['mode'],
    signal: AbortSignal,
    prepare: (item: InboxItem) => Promise<P>,
    commit: (item: InboxItem, prepared: P) => Promise<void>,
  ) {
    signal.throwIfAborted();
    for (let item = this.next(mode); item; item = this.next(mode)) {
      let prepared: P;
      try {
        prepared = await prepare(item);
      } catch (error) {
        signal.throwIfAborted();
        this.fail(item, error);
        continue;
      }
      signal.throwIfAborted();
      if (this.next(mode)?.id !== item.id) continue;
      // The message record durably acknowledges the inbox ID.
      await commit(item, prepared);
      return true;
    }
    return false;
  }

  failPending(mode: InboxItem['mode'], reason: string) {
    for (const item of this.list()) if (item.mode === mode) this.fail(item, reason);
  }

  cancel(reason: string, id?: string) {
    const ids = this.list()
      .filter((item) => id === undefined || item.id === id)
      .map((item) => item.id);
    if (ids.length) this.log.append({ type: 'inbox-cancelled', ids, reason });
    return this.view();
  }
}
