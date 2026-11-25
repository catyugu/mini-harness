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
  const scopes = new Map<string, () => void>();
  const syncScope = (id: string) => {
    const record = registry.get(id);
    if (!record) {
      scopes.get(id)?.();
      scopes.delete(id);
    } else if (!scopes.has(id)) {
      scopes.set(id, ctx.harnessProfileScopes.register(ctx, `session:${id}`, {
        key: registry.scope(id)!,
        parent: record.parentId
          ? `session:${record.parentId}`
          : record.workspaceId
            ? `workspace:${record.workspaceId}`
            : undefined,
      }));
    }
  };
  for (const { id } of registry.list()) syncScope(id);
  ctx.effect(() => {
    const changed = (event: Event) => syncScope((event as CustomEvent<{ id: string }>).detail.id);
    registry.events.addEventListener('change', changed);
    return () => registry.events.removeEventListener('change', changed);
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
