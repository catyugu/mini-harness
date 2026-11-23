import type { Context } from 'cordis';
import { projectSession } from './navigation.js';
import { registerSessionRoutes } from './routes.js';

export function setup(ctx: Context) {
  ctx.provide('harnessConversationView', {
    read(id) {
      const record = ctx.harnessRegistry.get(id);
      if (!record) throw new Error('Conversation not found');
      return { ...projectSession(ctx, record), ...ctx.harnessAgent.read(id),
        ...ctx.harnessRuns.view(id), logError: ctx.harnessRegistry.logError(id) };
    }
  });
  registerSessionRoutes(ctx);
}
