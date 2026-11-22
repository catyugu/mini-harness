import type { Context } from 'cordis';
import { ConversationOperations } from './operations.js';

export function setup(ctx: Context) {
  ctx.provide('harnessOperations', new ConversationOperations(
    ctx.harnessRegistry, ctx.harnessPi, ctx.harnessRuns, ctx.harnessSettingsStore));
}
