import type {} from '@mini-harness/platform/runtime-paths';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { LinuxSandbox } from './linux.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:sandbox', title: 'Sandbox', description: 'Prepare isolated execution environments',
  defaultEnabled: true,
  inject: ['harnessState'], provides: ['harnessSandbox'],
  setup(ctx) { ctx.provide('harnessSandbox', new LinuxSandbox(ctx.harnessState.paths.home)); }
};
