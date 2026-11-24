import { browserPluginId } from '@mini-harness/ui-runtime/plugin-settings';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import { field, fromMarkup, required, saveToggle, toggle } from '@mini-harness/ui-primitives/primitives';
import { payload } from '@mini-harness/ui-runtime/http';

const setup = (ctx: Context) => {
  ctx.effect(() => ctx.miniSettingsRegistry.registerPlugin(browserPluginId(ctx), {
    id: 'read-only-tools',
    render(pluginId, signal) {
      if (pluginId.startsWith('core:')) return;
      const path = '/permissions/plugins/' + encodeURIComponent(pluginId);
      const section = fromMarkup('<section class="ui-section" hidden><h3>Read-only conversation tools</h3><p class="hint">Grant access only to tools you trust to leave files and other state unchanged. Scope restrictions still apply.</p><p class="hint" role="status"></p></section>');
      const status = required(section.querySelector<HTMLElement>('[role="status"]'));
      void browserRequest<{ tools: string[]; grants: string[] }>(ctx, path, { signal }).then(({ tools, grants }) => {
        for (const name of new Set([...tools, ...grants])) {
          const control = toggle('Allow ' + name + ' in read-only conversations', grants.includes(name));
          control.disabled = !grants.includes(name) && !tools.includes(name);
          saveToggle(control, async (allowed) => {
            status.textContent = '';
            try {
              await browserRequest(ctx, path, { ...payload('PATCH', { tool: name, allowed }), signal });
              return true;
            } catch (error) {
              if (!signal.aborted) status.textContent = error instanceof Error ? error.message : String(error);
              return false;
            }
          });
          section.insertBefore(field(name, control), status);
        }
        section.hidden = !tools.length && !grants.length;
      }).catch((error: unknown) => {
        if (signal.aborted) return;
        section.hidden = false;
        status.textContent = error instanceof Error ? error.message : String(error);
      });
      return section;
    }
  }));
};

export default { inject: ['miniSettingsRegistry'], provide: [], apply: setup };
