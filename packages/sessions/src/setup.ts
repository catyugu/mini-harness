import type {} from '@mini-harness/kernel/observations';
import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/workspaces/api';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/kernel/mutation-api';
import type {} from '@mini-harness/transport/routes';
import type {} from '@mini-harness/settings/api';
import { recordsForPlugin, sessionAccess, type SessionAccess } from './records.js';
import type { Context } from 'cordis';
import { SessionRegistry } from './registry.js';

export function setup(ctx: Context) {
  const registry = new SessionRegistry(ctx.harnessState.paths, ctx.harnessWorkspaces, ctx.harnessScopes,
    (event) => ctx.emit('harness/observe', event),
    (keys) => ctx.harnessSettingsStore.forgetScopes(keys));
  ctx.effect(() => ctx.harnessScopes.register('session', (id) => {
    const record = registry.get(id);
    return record && {
      scope: { kind: 'session', sessionId: id, workspaceId: record.workspaceId },
      parent: record.parentId ? 'session:' + record.parentId : 'workspace:' + record.workspaceId
    };
  }));
  ctx.effect(() => ctx.harnessWorkspaces.beforeRemove((id) => registry.delete(registry.list(id).map((record) => record.id))));
  ctx.on('harness/ready', () => registry.recoverDeletion());
  ctx.on('harness/quiesce', () => registry.close());
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/status', () =>
    ({ pid: process.pid, sessionDiagnostics: registry.diagnostics() })));
  ctx.provide('harnessRegistry', registry);
  ctx.provide('harnessSessions', {
    [sessionAccess]: {
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
    } satisfies SessionAccess,
    [recordsForPlugin]: (id: string, pluginId: string, instanceId: string) => registry.records(id, pluginId, instanceId)
  });
  ctx.effect(() => () => registry.dispose());
}
