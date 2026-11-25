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

function identity(id: string) {
  return 'browser-entry:' + id;
}

function entry(item: BrowserEntry, context: Context, needsIdentity: boolean): EntryOptions {
  const { id, browser, preload, styles = [], config, liveConfig, requires = [], provides = [] } = item;
  return {
    id,
    context,
    config,
    live: liveConfig,
    module: JSON.stringify([browser, styles, preload, requires, provides, liveConfig, needsIdentity]),
    inject: requires.map(identity),
    async load() {
      const exports = await import(browser);
      const plugin = (exports.default ?? exports) as Plugin;
      const declared = typeof plugin.provide === 'string' ? [plugin.provide] : (plugin.provide ?? []);
      if (declared.length !== provides.length || declared.some((name) => !provides.includes(name)))
        throw new Error('Browser service declarations disagree with the manifest: ' + id);
      return plugin;
    },
    async prepare(ctx) {
      if (preload)
        await ctx.effect(async () => {
          try {
            const { default: start } = await import(preload);
            if (typeof start !== 'function') throw new Error('Expected a default pre-start function: ' + id);
            const cleanup: unknown = await start(ctx.fiber.signal);
            if (cleanup === undefined) return;
            if (typeof cleanup !== 'function') throw new Error('Invalid pre-start cleanup: ' + id);
            return cleanup as () => void;
          } catch (error) {
            throw new Error('Browser preload failed: ' + String(error), { cause: error });
          }
        });
      await Promise.all(styles.map((href) => stylesheet(href, ctx)));
    },
    verify(ctx) {
      const registered = new Set(
        [...ctx.fiber.provisions].map(({ name }) => name).filter((name) => name !== identity(id)),
      );
      if (
        provides.some((name) => !registered.has(name)) ||
        [...registered].some((name) => !provides.includes(name))
      )
        throw new Error('Browser service declarations do not match registrations: ' + id);
      if (needsIdentity) ctx.provide(identity(id), true);
    },
  };
}

export function browserModules(ctx: Context) {
  const entries = new EntryTree();
  let previous = Promise.resolve();
  return (snapshot: BrowserBootstrap) => {
    const update = previous.then(async () => {
      const identities = new Set(snapshot.ui.flatMap((item) => item.requires ?? []));
      const activationErrors = await entries.update(
        snapshot.ui.map((item) => entry(item, ctx, identities.has(item.id))),
      );
      const failures = new Map<string, unknown>();
      for (const { id } of snapshot.ui) {
        const plugin = entries.get(id);
        if (activationErrors.has(id)) {
          const error = activationErrors.get(id);
          failures.set(id, new Error('Browser setup failed: ' + String(error), { cause: error }));
        } else if (plugin && !plugin.active) {
          const missing = Object.keys(plugin.fiber?.inject ?? {}).filter((name) => ctx.get(name) == null);
          failures.set(id, new Error('Browser dependency unavailable: ' + missing.join(', ')));
        }
      }
      for (const { id } of snapshot.ui) if (!failures.has(id)) ctx.emit('browser/configured', id);
      return failures;
    });
    previous = update.then(
      () => {},
      () => {},
    );
    return update;
  };
}
