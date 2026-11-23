import type { FrontendSetup } from '#mini-harness/ui-runtime/frontend.js';

/** Theme presentation is owned by the theme plugin, not by the global data mirror. */
const setup: FrontendSetup = (ctx, api) => {
  const apply = () => {
    document.documentElement.dataset.theme = ctx.miniSettingsData.get().appearance;
  };
  apply();
  ctx.miniSettingsData.subscribe(apply, api.signal);
};

export default setup;
