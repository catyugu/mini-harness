import type { Context } from 'mini-harness/cordis';
import type { BrowserPrimitives } from 'mini-harness/ui-primitives';
import type { PageContribution } from 'mini-harness/ui-layout';
import type { SettingsContribution } from 'mini-harness/ui-settings';
import type { MessageAction } from 'mini-harness/conversation/history';

import { browserPluginId, browserPluginSettings } from 'mini-harness/ui-runtime/plugin-settings';

import { replaceComposer } from './web/composer.ts';

export const inject = [
  'miniPrimitives',
  'miniDialogs',
  'miniPages',
  'miniSettingsRegistry',
  'miniMessages',
  'miniComposer',
  'miniSlots',
  'miniConversation',
];

export function apply(ctx: Context, config: { replaceComposer: boolean }) {
  const ui: BrowserPrimitives = ctx.miniPrimitives;
  const { miniComposer } = ctx;
  const signal = ctx.fiber.signal;
  const id = browserPluginId(ctx);
  if (config.replaceComposer) replaceComposer(ctx);
  const panel = document.createElement('section');
  panel.tabIndex = -1;
  panel.append(ui.status('Example panel is ready.'));
  const open = ui.button('Preview', 'primary');
  const { node: modal, dispose } = ctx.miniDialogs.create(
    'Example preview',
    ui.status('This dialog belongs to the example panel.'),
  );
  ctx.effect(() => dispose);
  open.addEventListener('click', () => modal.showModal(), { signal });
  panel.append(open);
  ctx.effect(() =>
    ctx.miniPages.contribute(
      id + ':example',
      { title: 'Example panel', content: panel } satisfies PageContribution,
      signal,
    ),
  );
  ctx.effect(() =>
    ctx.miniSettingsRegistry.register(
      id,
      {
        id: 'example-info',
        section: 'Extensions',
        render: () => ui.status('The example panel can also replace the conversation composer.'),
      } satisfies SettingsContribution,
      browserPluginSettings(ctx),
    ),
  );
  ctx.effect(() =>
    ctx.miniMessages.registerAction({
      id: 'example-use-message',
      label: 'Use message in draft',
      icon: 'copy',
      visible: ({ message }) => message.role === 'assistant',
      run: ({ rawText }) => miniComposer.insert(rawText),
    } satisfies MessageAction),
  );
}
