import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { ModelStore } from '../server/store.ts';

export const metadata: PluginInfo = {
  title: 'Model store',
  description: 'Shared provider definitions and credentials',
};

const plugin: Plugin.Object = {
  inject: ['harnessState'],
  provide: ['harnessModelStore'],
  async apply(ctx) {
    const store = new ModelStore(
      ctx.harnessState.paths.home,
      (kind) => {
        void ctx.parallel('models/source-changed', kind).catch((error) => ctx.logger.warn(String(error)));
      },
      (error) => ctx.logger.warn(String(error)),
    );
    ctx.effect(() => () => store.close());
    await store.refresh();
    ctx.provide('harnessModelStore', store);
  },
};

export default plugin;
