import type { BuiltinPlugin } from '../contracts/plugins.js';
import { runShell } from './sandbox.js';

export const manifest: BuiltinPlugin = {
  id: 'core:process', title: 'Process execution', description: 'Isolated and explicitly authorized host processes', required: true,
  inject: ['harnessState'], provides: ['harnessProcess'],
  setup(ctx) {
    const { home } = ctx.harnessState.paths;
    const run: typeof ctx.harnessProcess.run = (command, cwd, options) => runShell(command, cwd, { ...options, stateDir: home });
    ctx.provide('harnessProcess', { run });
  }
};
