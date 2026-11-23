import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';
import { LinuxSandbox } from './linux.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:sandbox', title: 'Sandbox', description: 'Prepare isolated execution environments',
  required: true,
  inject: ['harnessState'], provides: ['harnessSandbox'],
  setup(ctx) { ctx.provide('harnessSandbox', new LinuxSandbox(ctx.harnessState.paths.home)); }
};
