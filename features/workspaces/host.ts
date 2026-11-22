import type { Context } from 'cordis';
import { WorkspaceCatalog } from '../../src/services/workspaces.js';

/** Workspace registration and path identity are owned by this core capability. */
export function setup(ctx: Context) {
  ctx.provide('harnessWorkspaces', new WorkspaceCatalog(ctx.harnessState.paths));
}
