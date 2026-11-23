import type { Context } from 'cordis';
import { SessionRegistry } from './registry.js';

export function setup(ctx: Context) {
  const registry = new SessionRegistry(ctx.harnessState.paths, ctx.harnessWorkspaces);
  ctx.provide('harnessRegistry', registry);
  ctx.provide('harnessSessions', { get: (id) => registry.get(id), list: (id) => registry.list(id) });
  ctx.provide('harnessWorkspace', { resolve: (id) => registry.workspacePath(id) });
}
