import type { Context } from 'cordis';
import { ConversationOperations } from './operations.js';
import { registerSessionRoutes } from './routes.js';

export function setup(ctx: Context) {
  ctx.provide('harnessOperations', new ConversationOperations(
    ctx.harnessRegistry, ctx.harnessPi, ctx.harnessRuns, ctx.harnessSettingsStore));
  registerSessionRoutes(ctx);
}
