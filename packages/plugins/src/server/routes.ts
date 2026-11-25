import { Service } from 'mini-harness/cordis';
import { pluginInstance } from '@mini-harness/plugin-api/instance';
import { withPluginRequest } from '@mini-harness/plugin-api/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import type { ScopedRequestPort } from '@mini-harness/transport/routes';

export const scopeOperation = /^[a-z][a-z0-9-]{0,63}$/;

export class ScopedRequests {
  private readonly requests = new Map<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>();

  get(id: string, name: string) {
    return this.requests.get(id + '/' + name);
  }

  service(): ScopedRequestPort {
    const { requests } = this;
    return Service.track({
      register(name, handler) {
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
