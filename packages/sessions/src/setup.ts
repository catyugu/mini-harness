import { observe } from '@mini-harness/plugin-api/observations';
import { terminal } from '@mini-harness/tasks/api';
import type { Context } from 'mini-harness/cordis';
import { applicationResources } from '@mini-harness/plugin-api/scopes';
import { SessionRegistry } from './registry.ts';

export function setup(ctx: Context) {
  const owner = applicationResources(ctx);
  const lifetime = ctx.fiber.signal;
  ctx.effect(function* () {
    yield ctx.harnessProfileScopes.register(owner, 'session', (id) => {
      const record = registry.get(id);
      return (
        record && {
          key: registry.scope(id)!,
          parent: record.parentId
            ? `session:${record.parentId}`
            : record.workspaceId
              ? `workspace:${record.workspaceId}`
              : undefined,
        }
      );
    });
    const registry = new SessionRegistry(
      ctx.harnessState.paths,
      () => ctx.get('harnessWorkspaces'),
      (event, key) => observe(ctx, event, undefined, key),
      (keys) => ctx.harnessProfileConfig.forgetScopes(keys, lifetime),
    );
    yield owner.provide('harnessSessions', registry);
    yield async () => {
      await registry.close();
      registry.dispose();
    };
    ctx.effect(() => {
      const changed = (event: Event) => {
        void ctx.harnessProfileScopes
          .changed(`session:${(event as CustomEvent<string>).detail}`)
          .catch((error) => ctx.logger.error(error));
      };
      registry.events.addEventListener('membership', changed);
      return () => registry.events.removeEventListener('membership', changed);
    });
    ctx.inject(['harnessWorkspaces'], (workspace) => {
      registry.bindWorkspaces(workspace.harnessWorkspaces);
      workspace.effect(() => () => registry.bindWorkspaces());
      workspace.effect(() =>
        workspace.harnessWorkspaces.beforeRemove((id) => registry.removeWorkspaceSessions(id)),
      );
    });
    ctx.inject(['harnessTasks'], (scope) => {
      const tasks = scope.harnessTasks;
      scope.effect(() =>
        registry.beforeDelete({
          busy: (id) => tasks.list('session:' + id).some((task) => !terminal(task.state)),
          async quiesce(ids) {
            await Promise.all(ids.map((id) => tasks.removeOwner('session:' + id)));
          },
        }),
      );
    });
    ctx.on('harness/ready', () => registry.recoverDeletion());
    ctx.on('harness/quiesce', () => registry.close());
    ctx.inject(['harnessRoutes'], (web) => {
      web.effect(() =>
        web.harnessRoutes.register('GET', '/api/status', () => ({
          pid: process.pid,
          sessionDiagnostics: registry.diagnostics(),
        })),
      );
    });
  });
}
