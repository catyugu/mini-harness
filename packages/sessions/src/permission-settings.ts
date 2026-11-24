import type { Context } from 'cordis';
import type {} from '@mini-harness/kernel/mutation-api';
import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/tools/api';
import type {} from '@mini-harness/transport/routes';
import { localPluginIdPattern } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';

export function setupPermissionSettings(ctx: Context) {
  const { harnessRoutes: routes, harnessMutations: mutations, harnessSettingsStore: settings, harnessTools: tools } = ctx;
  const path = '/api/permissions/plugins/:id';
  const inspect = (id: string) => {
    if (!localPluginIdPattern.test(id)) throw new DomainError('invalid_input', 'Invalid plugin identity');
    return { tools: tools.readOnlyRegistrations(id), grants: settings.settings.readOnlyTools[id] ?? [] };
  };
  ctx.effect(() => routes.register('GET', path, ({ params }) => inspect(params.id)));
  ctx.effect(() => routes.register('PATCH', path, async ({ params, body }) => {
    const { tool, allowed } = (await body()) ?? {};
    if (typeof tool !== 'string' || typeof allowed !== 'boolean')
      throw new DomainError('invalid_input', 'Expected a tool name and an authorization decision');
    return mutations.run(async () => {
      const { id } = params;
      const registrations = inspect(id);
      const selected = new Set(registrations.grants);
      if (allowed) {
        if (!registrations.tools.includes(tool)) throw new DomainError('invalid_input', 'Tool is not registered for read-only access');
        selected.add(tool);
      } else selected.delete(tool);
      const grants = { ...settings.settings.readOnlyTools };
      if (selected.size) grants[id] = [...selected];
      else delete grants[id];
      await settings.update({ readOnlyTools: grants });
      return inspect(id);
    });
  }));
}
