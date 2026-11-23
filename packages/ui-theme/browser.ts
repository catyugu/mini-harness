import type { BrowserPlugin } from '../ui-runtime/frontend.js';

/** Theme presentation is owned by the theme plugin, not by the global data mirror. */
export const themePlugin: BrowserPlugin = {
  id: 'core:theme',
  inject: ['miniState'],
  setup(ctx, api) {
    const apply = () => {
      document.documentElement.dataset.theme = ctx.miniState.get().settings.appearance;
    };
    apply();
    ctx.miniState.on('settings', apply, api.signal);
  }
};

export default themePlugin;
