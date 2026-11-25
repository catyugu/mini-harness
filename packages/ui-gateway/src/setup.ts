import type {} from '@mini-harness/transport/routes';
import type {} from '@mini-harness/plugins/api-types';
import type {} from '@mini-harness/transport/projection-api';
import type { BrowserBootstrap } from '@mini-harness/ui-runtime/bootstrap';
import type { Context } from 'mini-harness/cordis';
import { eventStream } from '@mini-harness/transport/http';

export function setup(ctx: Context) {
  const bootstrap = (): BrowserBootstrap => ({ ui: ctx.harnessPluginCatalog.browser() });
  ctx.provide('harnessGateway', { bootstrap });
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/bootstrap', bootstrap));
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/changes', ({ response }) => {
    const { send } = eventStream(response);
    const changes = ctx.harnessChanges;
    response.once('close', changes.subscribe(send));
    send(changes.snapshot());
  }));
}
