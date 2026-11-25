import type { Context } from 'mini-harness/cordis';
import { pluginIdPattern } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';

export function setupPermissionSettings(ctx: Context) {
  const {
    harnessRoutes: routes,
    harnessMutations: mutations,
    harnessSettingsStore: settings,
    harnessTools: tools,
  } = ctx;
  const path = '/api/permissions/plugins/:id';
  const inspect = (id: string) => {
    if (!pluginIdPattern.test(id)) throw new DomainError('invalid_input', 'Invalid plugin identity');
    return tools.readOnlyRegistrations(id).map((registration) => {
      const grant = settings.settings.readOnlyTools[registration.instanceId];
      return {
        ...registration,
        granted: grant?.module === registration.module && grant.tools.includes(registration.name),
      };
    });
  };
  ctx.effect(() => routes.register('GET', path, ({ params }) => inspect(params.id)));
  ctx.effect(() =>
    routes.register('PATCH', path, async ({ params, body }) => {
      const { instanceId, module, tools: names, allowed } = (await body()) ?? {};
      if (
        typeof instanceId !== 'string' ||
        typeof module !== 'string' ||
        !Array.isArray(names) ||
        !names.length ||
        !names.every((name: unknown) => typeof name === 'string') ||
        typeof allowed !== 'boolean'
      )
        throw new DomainError(
          'invalid_input',
          'Expected an instance, module, tool names and authorization decision',
        );
      return mutations.run(async () => {
        const { id } = params;
        const registrations = inspect(id).filter(
          (item) => item.instanceId === instanceId && item.module === module,
        );
        if (
          !registrations.length ||
          names.some((name: string) => !registrations.some((item) => item.name === name))
        )
          throw new DomainError('invalid_input', 'Tool registration is no longer available');
        const grants = { ...settings.settings.readOnlyTools };
        const previous = grants[instanceId];
        const selected = new Set(previous?.module === module ? previous.tools : []);
        for (const name of names) {
          if (allowed) selected.add(name);
          else selected.delete(name);
        }
        grants[instanceId] = { module, tools: [...selected] };
        await settings.update({ readOnlyTools: grants });
        return inspect(id);
      });
    }),
  );
}
