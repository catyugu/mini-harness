import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { LinuxSandbox } from './linux.ts';

export const metadata: PluginInfo = {
  title: 'Sandbox',
  description: 'Prepare isolated execution environments',
};

const plugin: Plugin.Object = {
  provide: ['harnessSandbox'],
  apply(ctx) {
    ctx.provide('harnessSandbox', new LinuxSandbox());
  },
};

export default plugin;
