import type {} from './api.js';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';

const setup: FrontendSetup = (ctx, api) => {
  const apply = (theme: string) => { document.documentElement.dataset.theme = theme; };
  apply(api.configuration.get<string>('appearance'));
  const unsubscribe = api.configuration.subscribe<string>('appearance', apply);
  ctx.provide('miniAppearance', api.configuration);
  return () => {
    unsubscribe();
    delete document.documentElement.dataset.theme;
  };
};

export default setup;
