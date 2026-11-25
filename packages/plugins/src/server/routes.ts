import { Service, type Context } from 'mini-harness/cordis';
import { pluginInstance } from '@mini-harness/plugin-api/instance';
import { withPluginRequest } from '@mini-harness/plugin-api/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import type { PluginRoutes, UpgradeHandler } from '@mini-harness/transport/routes';

const routePath = /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/;
export const scopeOperation = /^[a-z][a-z0-9-]{0,63}$/;

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

export class PluginRouteRegistry {
  private readonly requests = new Map<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>();

  constructor(
    private readonly ctx: Context,
    private readonly upgrade?: (path: string, handler: UpgradeHandler) => () => Promise<void>,
  ) {}

  get(id: string, name: string) {
    return this.requests.get(id + '/' + name);
  }

  service(): PluginRoutes {
    const { ctx, upgrade, requests } = this;
    return Service.track({
      register(method, path, handler) {
        const caller = Service.caller(this);
        const { pluginId, scopeKey } = pluginInstance(caller);
        if (scopeKey || !path.startsWith('/')) throw new Error('Invalid plugin route');
        const lifetime = caller.fiber.signal;
        return networkEffect(caller, () =>
          ctx.harnessRoutes.register(method, '/api/extensions/' + pluginId + path, (request) =>
            caller.fiber
              .run(
                (signal) => withPluginRequest(signal, () => handler({ ...request, signal })),
                request.signal,
              )
              .catch((error) => {
                if (lifetime.aborted)
                  throw new DomainError('invalid_input', 'Route is no longer available', { cause: error });
                throw error;
              }),
          ),
        );
      },
      upgrade(path, handler) {
        const caller = Service.caller(this);
        const { pluginId, scopeKey } = pluginInstance(caller);
        if (scopeKey || !routePath.test(path) || !upgrade) throw new Error('Invalid WebSocket route');
        return networkEffect(caller, () =>
          upgrade('/api/extensions/' + pluginId + path, (request, socket, head, signal) =>
            caller.fiber.run(
              (lifetime) => withPluginRequest(lifetime, () => handler(request, socket, head, lifetime)),
              signal,
            ),
          ),
        );
      },
      scope(name, handler) {
        const caller = Service.caller(this);
        const { instanceId, scopeKey } = pluginInstance(caller);
        if (!scopeKey || !scopeOperation.test(name) || typeof handler !== 'function')
          throw new Error('Invalid scoped plugin request');
        const key = instanceId + '/' + name;
        return caller.effect(() => {
          if (requests.has(key)) throw new Error('Duplicate scoped request: ' + name);
          const lifetime = caller.fiber.signal;
          requests.set(key, (input, request) =>
            caller.fiber
              .run((signal) => withPluginRequest(signal, () => handler(input, signal)), request)
              .catch((error) => {
                if (lifetime.aborted)
                  throw new DomainError('unavailable', 'Scoped plugin is no longer available', {
                    cause: error,
                  });
                throw error;
              }),
          );
          return () => {
            requests.delete(key);
          };
        });
      },
    });
  }
}
