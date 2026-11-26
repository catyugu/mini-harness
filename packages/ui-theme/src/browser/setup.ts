import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import type { Context } from 'mini-harness/cordis';

const setup = (ctx: Context) => {
  const apply = (theme: string) => {
    document.documentElement.dataset.theme = theme;
  };
  const configuration = browserPluginSettings(ctx);
  apply(configuration.get<string>('appearance'));
  const unsubscribe = configuration.subscribe<string>('appearance', apply);
  ctx.inject(['miniSettingsRegistry'], (settings) => {
    settings.effect(() =>
      settings.miniSettingsRegistry.register(
        browserPluginId(ctx),
        {
          id: 'theme',
          section: { title: 'General', icon: 'settings', order: 10 },
          order: -10,
          render({ bind }) {
            const content = document.createElement('div');
            content.className = 'settings-preference';
            const label = document.createElement('label');
            label.className = 'switch-line';
            const title = document.createElement('strong');
            title.textContent = 'Theme';
            const theme = document.createElement('select');
            theme.name = 'appearance';
            theme.add(new Option('System', 'system'));
            theme.add(new Option('Light', 'light'));
            theme.add(new Option('Dark', 'dark'));
            label.append(title, theme);
            content.append(
              label,
              bind<string>(theme, 'appearance', {
                read: (value) => {
                  theme.value = value;
                },
                write: () => theme.value,
              }),
            );
            return content;
          },
        },
        configuration,
      ),
    );
  });
  return () => {
    unsubscribe();
    delete document.documentElement.dataset.theme;
  };
};

export default { inject: [], provide: [], apply: setup };
