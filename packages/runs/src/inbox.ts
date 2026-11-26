import type { SessionLogPort, InboxItem } from '@mini-harness/sessions/log-api';

/** Acceptance and delivery acknowledgements live in the session log. */
export class Inbox {
  constructor(private readonly log: SessionLogPort) {}

  private next(modes: readonly InboxItem['mode'][]) {
    const items = this.log.inbox();
    for (const mode of modes) {
      const item = items.find((item) => item.mode === mode);
      if (item) return item;
    }
  }

  private fail(item: InboxItem, error: unknown) {
    if (this.log.inbox().some(({ id }) => id === item.id))
      this.log.append({
        type: 'inbox-failed',
        inboxId: item.id,
        reason: error instanceof Error ? error.message : String(error),
      });
  }

  hasValid(mode: InboxItem['mode'], validate: (item: InboxItem) => unknown) {
    for (let item = this.next([mode]); item; item = this.next([mode])) {
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
    modes: readonly InboxItem['mode'][],
    signal: AbortSignal,
    prepare: (item: InboxItem) => Promise<P>,
    commit: (item: InboxItem, prepared: P) => Promise<void>,
    requireInput = false,
  ) {
    signal.throwIfAborted();
    let failure: { error: unknown } | undefined;
    for (let item = this.next(modes); item; item = this.next(modes)) {
      let prepared: P;
      try {
        prepared = await prepare(item);
      } catch (error) {
        signal.throwIfAborted();
        this.fail(item, error);
        failure = { error };
        continue;
      }
      signal.throwIfAborted();
      if (this.next(modes)?.id !== item.id) continue;
      await commit(item, prepared);
      return true;
    }
    if (requireInput && failure) throw failure.error;
    return false;
  }

  cancel(reason: string, id?: string) {
    const ids = this.log
      .inbox()
      .filter((item) => id === undefined || item.id === id)
      .map((item) => item.id);
    if (ids.length) this.log.append({ type: 'inbox-cancelled', ids, reason });
    return this.log.queue();
  }
}
