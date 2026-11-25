import { browserPluginId } from '@mini-harness/ui-runtime/plugin-settings';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import { field, fromMarkup, required, saveToggle, toggle } from '@mini-harness/ui-primitives/primitives';
import { payload } from '@mini-harness/ui-runtime/http';

const setup = (ctx: Context) => {
  ctx.effect(() =>
    ctx.miniSettingsRegistry.registerPlugin(browserPluginId(ctx), {
      id: 'read-only-tools',
      render(pluginId, signal) {
        const path = '/permissions/plugins/' + encodeURIComponent(pluginId);
        const section = fromMarkup(
          '<section class="ui-section" hidden><h3>Read-only conversation tools</h3><p class="hint">Grant access only to tools you trust to leave files and other state unchanged. Scope restrictions still apply.</p><p class="hint" role="status"></p></section>',
        );
        const status = required(section.querySelector<HTMLElement>('[role="status"]'));
        void browserRequest<{ instanceId: string; module: string; name: string; granted: boolean }[]>(
          ctx,
          path,
          { signal },
        )
          .then((registrations) => {
            for (const { instanceId, module, name, granted } of registrations) {
              const control = toggle('Allow ' + name + ' in read-only conversations', granted);
              saveToggle(control, async (allowed) => {
                status.textContent = '';
                try {
                  await browserRequest(ctx, path, {
                    ...payload('PATCH', { instanceId, module, tools: [name], allowed }),
                    signal,
                  });
                  return true;
                } catch (error) {
                  if (!signal.aborted)
                    status.textContent = error instanceof Error ? error.message : String(error);
                  return false;
                }
              });
              section.insertBefore(field(name + ' · ' + instanceId, control), status);
            }
            section.hidden = !registrations.length;
          })
          .catch((error: unknown) => {
            if (signal.aborted) return;
            section.hidden = false;
            status.textContent = error instanceof Error ? error.message : String(error);
          });
        return section;
      },
    }),
  );
};

export default { inject: ['miniSettingsRegistry'], provide: [], apply: setup };
