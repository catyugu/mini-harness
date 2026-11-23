import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelAdminPort } from '../contracts/models.js';

export function modelAdmin(runtime: ModelRuntime, invalidate: (id: string) => void): ModelAdminPort {
  return {
    providers: () => runtime.getProviders().map((provider) => ({
      id: provider.id, name: provider.name ?? provider.id, canSetKey: Boolean(provider.auth.apiKey?.login),
      models: runtime.getModels(provider.id).map(({ id, name, input, contextWindow, maxTokens, reasoning }) => ({
        id, name, input, contextWindow, maxTokens, reasoning
      }))
    })),
    authStatus: (id) => runtime.getProviderAuthStatus(id),
    hasProvider: (id) => Boolean(runtime.getProvider(id)),
    async refresh() {
      await runtime.refresh({ allowNetwork: false });
      const error = runtime.getError();
      if (error) throw new Error(error);
    },
    async storeCredential(id, key) {
      await runtime.login(id, 'api_key', {
        prompt: async (prompt) => {
          if (prompt.type !== 'secret') throw new Error('This provider requires additional credential setup through Pi');
          return key;
        },
        notify: () => {}
      });
    },
    async removeCredential(id) { await runtime.logout(id); },
    invalidate
  };
}
