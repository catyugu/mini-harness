import type {} from '@mini-harness/kernel/observations';
import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/workspaces/api';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/settings/api';
import { bindSessionAccess, sessionAccess } from './records.js';
import type { Context } from 'cordis';
import { SessionRegistry } from './registry.js';

export function setup(ctx: Context) {
  const registry = new SessionRegistry(ctx.harnessState.paths, ctx.harnessWorkspaces,
    (event) => ctx.emit('harness/observe', event),
    (keys) => ctx.harnessSettingsStore.forgetScopes(keys));
  ctx.provide('harnessRegistry', registry);
  ctx.provide('harnessScopeDirectory', { address: (key: string) => registry.scopeAddress(key) });
  ctx.provide('harnessSessions', {
    [bindSessionAccess]: (source) => sessionAccess(registry, source, (id, pluginId) => registry.records(id, pluginId))
  });
  ctx.effect(() => ctx.harnessWorkspaces.beforeRemove((id) => registry.delete(registry.list(id).map((record) => record.id))));
  ctx.on('harness/status', (status) => { status.sessionDiagnostics = registry.diagnostics(); });
  ctx.on('harness/startup', (pending) => { pending.push(registry.recoverDeletion()); });
  ctx.on('harness/quiesce', (pending) => { pending.push(registry.close()); });
  ctx.effect(() => () => registry.dispose());
}
