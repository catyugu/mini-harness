import { observe } from '@mini-harness/plugin-api/observations';
import type { Context } from 'mini-harness/cordis';
import { SessionRegistry } from './registry.ts';

export function setup(ctx: Context) {
  const registry = new SessionRegistry(
    ctx.harnessState.paths,
    () => ctx.get('harnessWorkspaces'),
    (event, key) => observe(ctx, event, undefined, key),
    (keys) => ctx.harnessProfileConfig.forgetScopes(keys),
  );
  ctx.harnessProfileScopes.register(ctx, 'session', (id) => {
    const record = registry.get(id);
    const key = registry.scope(id);
    return record && key && {
      key,
      parent: record.parentId
        ? `session:${record.parentId}`
        : record.workspaceId
          ? `workspace:${record.workspaceId}`
          : undefined,
    };
  });
  ctx.on('settings/scopes', (options) => {
    for (const { id, title } of registry.list()) options.push({ key: `session:${id}`, name: title });
  });
  ctx.inject(['harnessWorkspaces'], (workspace) => {
    registry.bindWorkspaces(workspace.harnessWorkspaces);
    workspace.effect(() => () => registry.bindWorkspaces());
    workspace.effect(() =>
      workspace.harnessWorkspaces.beforeRemove((id) => registry.removeWorkspaceSessions(id)),
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
  ctx.provide('harnessSessions', registry);
  ctx.effect(() => () => registry.dispose());
}
