import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/workspaces/api';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { Workspace } from './workspace.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:file-access', title: 'File access', description: 'Access paths within registered workspaces',
  required: true,
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
