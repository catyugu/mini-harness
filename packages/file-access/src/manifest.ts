import { resolve } from 'node:path';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { RootedFiles } from './root.ts';

export const metadata: PluginInfo = {
  title: 'File access',
  description: 'Access files within a directory',
};

const plugin: Plugin.Object = {
  inject: ['harnessState'],
  provide: ['harnessFileAccess'],
  apply(ctx) {
    const { home } = ctx.harnessState.paths;
    ctx.provide('harnessFileAccess', {
      open(root: string) {
        return new RootedFiles(resolve(root), home);
      },
    });
  },
};

export default plugin;
