import type { Context } from 'mini-harness/cordis';
import { pluginConfiguration, pluginEntryFiber } from '@mini-harness/plugin-api/plugin-configuration';
import { browserRequest, payload } from './http.ts';

export function browserPluginId(ctx: Context) {
  return pluginEntryFiber(ctx).entry!.options.id;
}

export function browserPluginSettings(ctx: Context) {
  const id = browserPluginId(ctx);
  return pluginConfiguration(
    ctx,
    async (values, signal) => {
      await browserRequest(ctx, '/settings/plugins/' + encodeURIComponent(id), {
        ...payload('PATCH', values),
        signal,
      });
      const failures = await ctx.get('miniSwitch')?.();
      if (failures?.has(id)) throw failures.get(id);
    },
    (notify) =>
      ctx.on('browser/configured', (entry) => {
        if (entry === id) notify();
      }),
  );
}

declare module 'mini-harness/cordis' {
  interface Events {
    'browser/configured'(id: string): void;
  }
}
