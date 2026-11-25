import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { Workspace } from './workspace.ts';

export const metadata: PluginInfo = {
  title: 'File access',
  description: 'Access paths within registered workspaces',
};

const plugin: Plugin.Object = {
  inject: ['harnessState', 'harnessWorkspaces', 'harnessChanges'],
  provide: ['harnessFileAccess'],
  apply(ctx) {
    ctx.effect(() => ctx.harnessChanges.register('files'));
    const { home } = ctx.harnessState.paths;
    const workspaces = ctx.harnessWorkspaces;
    ctx.provide('harnessFileAccess', {
      open(id: string) {
        const { path } = workspaces.get(id);
        return new Workspace(workspaces.resolveRoot(path, id), home);
      },
    });
  },
};

export default plugin;
