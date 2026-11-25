import { EntryTree, type Context, type EntryOptions, type Plugin } from 'mini-harness/cordis';
import type { BrowserBootstrap, BrowserEntry } from '../shared/bootstrap.ts';

function stylesheet(href: string, ctx: Context) {
  const signal = AbortSignal.any([ctx.fiber.signal, AbortSignal.timeout(8000)]);
  return new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    const abort = () => reject(signal.reason);
    const settle = (error?: Error) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    ctx.effect(() => {
      signal.addEventListener('abort', abort, { once: true });
      link.onload = () => settle();
      link.onerror = () => settle(new Error('Could not load browser stylesheet ' + href));
      document.head.append(link);
      return () => {
        signal.removeEventListener('abort', abort);
        link.remove();
      };
    });
  });
}

function entry(item: BrowserEntry, context: Context): EntryOptions {
  const { id, browser, styles = [], config, live } = item;
  return {
    id,
    context,
    config,
    live,
    module: JSON.stringify([browser, styles, live]),
    async load() {
      const exports = await import(browser);
      return (exports.default ?? exports) as Plugin;
    },
    async prepare(ctx) {
      await Promise.all(styles.map((href) => stylesheet(href, ctx)));
    },
  };
}

export function browserModules(ctx: Context) {
  const entries = new EntryTree();
  let previous = Promise.resolve();
  return (snapshot: BrowserBootstrap) => {
    const update = previous.then(async () => {
      const activationErrors = await entries.update(snapshot.ui.map((item) => entry(item, ctx)));
      const failures = new Map<string, unknown>();
      for (const { id } of snapshot.ui) {
        if (activationErrors.has(id)) {
          const error = activationErrors.get(id);
          failures.set(id, new Error('Browser setup failed: ' + String(error), { cause: error }));
        }
      }
      for (const { id } of snapshot.ui) if (entries.get(id)?.active) ctx.emit('browser/configured', id);
      return failures;
    });
    previous = update.then(
      () => {},
      () => {},
    );
    return update;
  };
}
