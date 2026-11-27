import { Context, type Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { scopeOf } from '@mini-harness/plugin-api/scopes';
import { ModelStore } from '../server/store.ts';

export const metadata: PluginInfo = {
  title: 'Model store',
  description: 'Shared provider definitions and credentials',
};

const plugin: Plugin.Object = {
  inject: ['harnessState'],
  provide: ['harnessModelStore'],
  async apply(ctx) {
    if (
      scopeOf(ctx) ||
      ctx[Context.isolate].harnessModelStore !== ctx[Context.root][Context.isolate].harnessModelStore
    )
      throw new Error('The model store belongs to the application scope');
    const store = new ModelStore(
      ctx.harnessState.paths.home,
      (kind) => {
        void ctx.parallel('models/source-changed', kind).catch((error) => ctx.logger.warn(String(error)));
      },
      (error) => ctx.logger.warn(String(error)),
    );
    ctx.effect(() => {
      ctx.provide('harnessModelStore', store);
      return () => store.close();
    });
    await store.refresh();
  },
};

export default plugin;
