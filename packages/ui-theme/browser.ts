import type { BrowserPlugin } from '../ui-runtime/frontend.js';

/** Theme presentation is owned by the theme plugin, not by the global data mirror. */
export const themePlugin: BrowserPlugin = {
  id: 'core:theme',
  inject: ['miniSettingsData'],
  setup(ctx, api) {
    const apply = () => {
      document.documentElement.dataset.theme = ctx.miniSettingsData.get().appearance;
    };
    apply();
    ctx.miniSettingsData.subscribe(apply, api.signal);
  }
};

export default themePlugin;
