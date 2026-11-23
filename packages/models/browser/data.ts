import type { ModelCatalog } from '@mini-harness/web/types';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import { RemoteStore } from '@mini-harness/web/models/remote-store';

const setup: FrontendSetup = async (ctx, api) => {
  const store = new RemoteStore(async () => {
    const [{ models }, providers] = await Promise.all([
      api.request<Pick<ModelCatalog, 'models'>>('/models'), api.request<ModelCatalog['providers']>('/providers')
    ]);
    return { models, providers };
  });
  await store.refresh();
  api.onDispose(ctx.miniProjections.register('models', store));
  ctx.provide('miniModels', store);
};

declare module 'cordis' {
  interface Context { miniModels: RemoteStore<ModelCatalog> }
}

export default setup;
