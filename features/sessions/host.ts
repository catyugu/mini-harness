import type { Context } from 'cordis';
import { SessionRegistry } from '../../src/services/conversations.js';

export function setup(ctx: Context) {
  const registry = new SessionRegistry(ctx.harnessState.paths, ctx.harnessWorkspaces);
  ctx.provide('harnessRegistry', registry);
  ctx.provide('harnessSessions', { get: (id: string) => registry.get(id), list: () => registry.list() });
  ctx.provide('harnessWorkspace', { resolve: (id: string) => registry.workspacePath(id) });
  ctx.provide('harnessSessionChanged', (id: string) => registry.notify(id));
}
