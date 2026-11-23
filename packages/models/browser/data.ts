import type { ModelCatalog } from '../../web/types.js';
import type { FrontendSetup } from '../../ui-runtime/frontend.js';
import { RemoteStore } from '../../web/models/remote-store.js';

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
