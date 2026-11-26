import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { ToolRegistry } from './registry.ts';

export const metadata: PluginInfo = {
  title: 'Tools',
  description: 'Tool registration and execution leases',
};

const plugin: Plugin.Object = {
  inject: ['harnessTasks'],
  provide: ['harnessTools'],
  apply(ctx) {
    ctx.provide('harnessTools', new ToolRegistry(ctx.harnessTasks).service());
  },
};

export default plugin;
