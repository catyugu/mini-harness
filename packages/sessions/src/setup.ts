import { observe } from '@mini-harness/plugin-api/observations';
import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/workspaces/api';
import type {} from '@mini-harness/plugin-api/scopes';
import type {} from '@mini-harness/plugin-api/mutation-api';
import type {} from '@mini-harness/transport/routes';
import type {} from '@mini-harness/settings/api';
import { sessionDirectory } from './records.js';
import type { Context } from 'mini-harness/cordis';
import { SessionRegistry } from './registry.js';

export function setup(ctx: Context) {
  const registry = new SessionRegistry(ctx.harnessState.paths, ctx.harnessWorkspaces, ctx.harnessScopes,
    (event) => observe(ctx, event),
    (keys) => ctx.harnessSettingsStore.forgetScopes(keys));
  ctx.effect(() => ctx.harnessScopes.register('session', (id) => {
    const record = registry.get(id);
    return record && {
      scope: { kind: 'session', sessionId: id, workspaceId: record.workspaceId },
      parent: record.parentId ? `session:${record.parentId}` : `workspace:${record.workspaceId}`
    };
  }));
  ctx.effect(() => ctx.harnessWorkspaces.beforeRemove((id) => registry.removeWorkspaceSessions(id)));
  ctx.on('harness/ready', () => registry.recoverDeletion());
  ctx.on('harness/quiesce', () => registry.close());
  ctx.inject(['harnessRoutes'], web => {
    web.effect(() => web.harnessRoutes.register('GET', '/api/status', () =>
      ({ pid: process.pid, sessionDiagnostics: registry.diagnostics() })));
  });
  ctx.provide('harnessRegistry', registry);
  ctx.provide('harnessSessions', sessionDirectory({
      get: (id) => registry.get(id),
      list: (id) => registry.list(id),
      create: (input) => registry.create(input),
      rename: (id, title) => { registry.assertAvailable(id); return registry.rename(id, title); },
      depth: (id) => registry.depth(id),
      workspacePath: (id) => registry.workspacePath(id),
      history(id) {
        registry.assertAvailable(id);
        if (!registry.get(id)) throw new Error('Conversation not found');
        return registry.inspectLog(id, (log) => {
          const { messages, leafId, model } = log.projection();
          return structuredClone({ messages, leafId, model });
        }, true) ?? { messages: [], leafId: null };
      }
  }, (id, owner) => registry.records(id, owner)));
  ctx.effect(() => () => registry.dispose());
}
