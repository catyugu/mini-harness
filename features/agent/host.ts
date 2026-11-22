import type { Context } from 'cordis';
import { ToolRegistry } from '../../src/kernel/tool-registry.js';
import { PiSessions } from '../../src/adapters/pi/sessions.js';

/** The Pi SDK and model runtime belong to Agent, never the Cordis kernel. */
export async function setup(ctx: Context) {
  ctx.provide('harnessTools', new ToolRegistry());
  const pi = new PiSessions(ctx.harnessState.paths, ctx.harnessRegistry, ctx,
    () => ctx.harnessSettings().model,
    (model) => ctx.harnessSettingsStore.rememberModel(model),
    (id) => ctx.harnessOperations.assertAvailable(id),
    (id) => ctx.harnessRuns?.active(id) ?? false);
  await pi.start();
  ctx.provide('harnessPi', pi);
  ctx.provide('harnessModels', { list: () => pi.availableModels() });
  ctx.effect(() => ctx.harnessSettingsStore.validate((next) => { pi.resolveModel(next.model); }));
}
