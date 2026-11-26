import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { ToolRegistry } from './registry.ts';

export const metadata: PluginInfo = {
  title: 'Tools',
  description: 'Tool registration and execution leases',
};

const plugin: Plugin.Object = {
  provide: ['harnessTools'],
  apply(ctx) {
    ctx.provide('harnessTools', new ToolRegistry().service());
  },
};

export default plugin;
