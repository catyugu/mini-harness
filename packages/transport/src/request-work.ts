import { AsyncLocalStorage } from 'node:async_hooks';

// A request may remove its own route while awaiting configuration. Never join itself.
const current = new AsyncLocalStorage<AbortController>();

export class RequestWork {
  private readonly active = new Map<AbortController, Promise<unknown>>();

  run<T>(controller: AbortController, handle: () => T | Promise<T>) {
    const work = Promise.resolve().then(() => current.run(controller, handle));
    this.active.set(controller, work);
    return work.finally(() => this.active.delete(controller));
  }

  async close(reason?: unknown) {
    const pending: Promise<unknown>[] = [];
    for (const [controller, work] of this.active) {
      if (controller === current.getStore()) continue;
      controller.abort(reason);
      pending.push(work);
    }
    await Promise.allSettled(pending);
  }
}
