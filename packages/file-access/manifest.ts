import type { PluginDescriptor } from '../contracts/plugins.js';
import { Workspace } from './workspace.js';

export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application',
  id: 'core:file-access', title: 'File access', description: 'Access paths within registered workspaces',
  required: true, replaceable: true,
  inject: ['harnessState', 'harnessWorkspaces'], provides: ['harnessFileAccess'],
  setup(ctx) {
    const { home } = ctx.harnessState.paths;
    const workspaces = ctx.harnessWorkspaces;
    ctx.provide('harnessFileAccess', {
      open(id: string) {
        const { path } = workspaces.get(id);
        return new Workspace(workspaces.resolveRoot(path, id), home);
      }
    });
  }
};
