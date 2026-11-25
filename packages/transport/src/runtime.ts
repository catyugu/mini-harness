import { Service, type Context } from 'mini-harness/cordis';
import { withPluginRequest } from '@mini-harness/plugin-api/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import type { RoutePort, UpgradePort } from './routes.ts';
import { MutationGate } from './mutations.ts';
import { ProjectionChanges } from './projections.ts';
import { RouteRegistry } from './router.ts';
import { Upgrades } from './upgrade.ts';

export default {
  provide: ['harnessMutations', 'harnessChanges'],
  apply(ctx: Context) {
    const mutations = new MutationGate();
    ctx.provide('harnessMutations', mutations);
    ctx.provide('harnessChanges', new ProjectionChanges());
    ctx.on('harness/seal', () => mutations.seal());
    ctx.on('harness/drain', async () => {
      await mutations.drain();
    });
  },
};

function networkEffect(ctx: Context, register: () => () => Promise<void>) {
  const signal = ctx.fiber.signal;
  return ctx.effect(() => {
    const release = register();
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= release());
    // Closing the transport also aborts body reads and WebSocket I/O.
    const abort = () => {
      void close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    return () => {
      signal.removeEventListener('abort', abort);
      return close();
    };
  });
}

export const http = {
  provide: ['harnessRoutes', 'harnessUpgrades'],
  apply(ctx: Context) {
    const routes = new RouteRegistry();
    const upgrades = new Upgrades();
    ctx.provide('harnessRoutes', Service.track<RoutePort>({
      register(method, path, handler) {
        const caller = Service.caller(this);
        const lifetime = caller.fiber.signal;
        return networkEffect(caller, () =>
          routes.register(method, path, (request) =>
            caller.fiber.run(
              (signal) => withPluginRequest(signal, () => handler({ ...request, signal }), caller.fiber),
              request.signal,
            ).catch((error) => {
              if (lifetime.aborted)
                throw new DomainError('invalid_input', 'Route is no longer available', { cause: error });
              throw error;
            }),
          ),
        );
      },
      dispatch: routes.dispatch.bind(routes),
    }));
    ctx.provide('harnessUpgrades', Service.track<UpgradePort>({
      register(path, handler) {
        const caller = Service.caller(this);
        return networkEffect(caller, () =>
          upgrades.register(path, (request, socket, head, signal) =>
            caller.fiber.run(
              (lifetime) => withPluginRequest(lifetime, () => handler(request, socket, head, lifetime), caller.fiber),
              signal,
            ),
          ),
        );
      },
      dispatch: upgrades.dispatch.bind(upgrades),
      close: upgrades.close.bind(upgrades),
    }));
    ctx.on('harness/seal', () => {
      routes.seal();
      upgrades.close();
    });
    ctx.on('harness/drain', () => routes.drain());
  },
};

