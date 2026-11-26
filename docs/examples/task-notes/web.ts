import type { Context } from 'mini-harness/cordis';

import { browserPluginId, browserPluginSettings } from 'mini-harness/ui-runtime/plugin-settings';
import type { BrowserPrimitives } from 'mini-harness/ui-primitives';
import type { RecordRenderer } from 'mini-harness/conversation/history';
import type { SettingsContribution } from 'mini-harness/ui-settings';

export const inject = ['miniPrimitives', 'miniMessages', 'miniSettingsRegistry'];

export function apply(ctx: Context) {
  const miniPrimitives: BrowserPrimitives = ctx.miniPrimitives;
  const renderRecord: RecordRenderer = (record) =>
    miniPrimitives.status(record.title + ': ' + String(record.content ?? ''));
  ctx.effect(() => ctx.miniMessages.registerRecord(browserPluginId(ctx), 'note', renderRecord));
  ctx.effect(() =>
    ctx.miniMessages.registerTool('save_task_note', () => miniPrimitives.status('Saved to task notes')),
  );
  ctx.effect(() =>
    ctx.miniSettingsRegistry.register(
      browserPluginId(ctx),
      {
        section: 'Extensions',
        id: 'task-notes',
        render({ bind }) {
          const input = document.createElement('input');
          const field = miniPrimitives.field('Task note label', input);
          field.append(
            bind<string>(input, 'label', {
              read(value) {
                input.value = value;
              },
              write() {
                return input.value;
              },
            }),
          );
          return field;
        },
      } satisfies SettingsContribution,
      browserPluginSettings(ctx),
    ),
  );
}
