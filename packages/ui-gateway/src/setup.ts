import type {} from '@mini-harness/transport/routes';
import type {} from '@mini-harness/plugins/api-types';
import type {} from '@mini-harness/transport/projection-api';
import type { BrowserBootstrap } from '@mini-harness/ui-runtime/bootstrap';
import type { Context } from 'cordis';
import { eventStream } from '@mini-harness/transport/http';

export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/bootstrap', (): BrowserBootstrap => ({
    ui: ctx.harnessPluginCatalog.browser()
  })));
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/changes', ({ response }) => {
    const signal = ctx.get('harnessTransportSignal');
    signal?.throwIfAborted();
    const { send } = eventStream(response);
    const changes = ctx.harnessChanges;
    const release = changes.subscribe(send);
    const shutdown = () => response.end();
    signal?.addEventListener('abort', shutdown, { once: true });
    response.once('close', () => {
      release();
      signal?.removeEventListener('abort', shutdown);
    });
    send(changes.snapshot());
  }));
}
