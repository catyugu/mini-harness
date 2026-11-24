import { settingsExtensions } from '@mini-harness/contracts/settings-browser';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';

const setup: FrontendSetup = (_ctx, api) => {
  const apply = (theme: string) => { document.documentElement.dataset.theme = theme; };
  apply(api.configuration.get<string>('appearance'));
  api.configuration.subscribe<string>('appearance', apply);
  api.contribute(settingsExtensions.register, {
    id: 'theme',
    section: { title: 'Appearance', icon: 'theme', order: 30 },
    render({ bind }) {
      const content = document.createElement('div');
      content.className = 'settings-field';
      const label = document.createElement('label');
      label.textContent = 'Theme';
      const theme = document.createElement('select');
      theme.add(new Option('System', 'system'));
      theme.add(new Option('Light', 'light'));
      theme.add(new Option('Dark', 'dark'));
      label.append(theme);
      content.append(label, bind<string>(theme, 'appearance', {
        read: (value) => { theme.value = value; },
        write: () => theme.value,
      }));
      return content;
    }
  });
};

export default setup;
