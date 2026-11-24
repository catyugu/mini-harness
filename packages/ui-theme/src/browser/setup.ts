import { browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import type { Context } from 'mini-harness/cordis';
import type {} from './api.js';

const setup = (ctx: Context) => {
  const apply = (theme: string) => { document.documentElement.dataset.theme = theme; };
  apply(browserPluginSettings(ctx).get<string>('appearance'));
  const unsubscribe = browserPluginSettings(ctx).subscribe<string>('appearance', apply);
  ctx.provide('miniAppearance', browserPluginSettings(ctx));
  return () => {
    unsubscribe();
    delete document.documentElement.dataset.theme;
  };
};

export default { inject: [], provide: ['miniAppearance'], apply: setup };
