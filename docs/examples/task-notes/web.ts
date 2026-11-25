import type { Context } from 'mini-harness/cordis';

const sdkUrl: string = '/packages/sdk/src/browser-plugin.js';
const { browserPluginId, browserPluginSettings } = (await import(
  sdkUrl
)) as typeof import('mini-harness/browser-plugin');

export const inject = ['miniPrimitives', 'miniMessages', 'miniSettingsRegistry'];

export function apply(ctx: Context) {
  const { miniPrimitives } = ctx;
  ctx.effect(() =>
    ctx.miniMessages.registerRecord(browserPluginId(ctx), (record) =>
      miniPrimitives.status(record.title + ': ' + String(record.content ?? '')),
    ),
  );
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
      },
      browserPluginSettings(ctx),
    ),
  );
}
