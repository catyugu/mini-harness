import type { WorkspaceView } from '@mini-harness/file-access/browser/views';
import type { Context } from 'mini-harness/cordis';
import { fileCompletion } from './completion.ts';
import { fileTree } from './tree.ts';

function setup(ctx: Context) {
  type Directory = { path: string; expanded: Set<string> };
  const tab = ctx.miniTabs.register<Directory>('directory', {
    title: ({ path }) => (path === '.' ? 'Files' : (path.split('/').at(-1) ?? path)),
    create: ({ path, expanded }, scope, signal) =>
      fileTree(ctx, scope, path, signal, expanded, (path) => open(path, scope)),
  });
  function open(path: string, { workspaceId }: WorkspaceView) {
    tab.open({ owner: { workspaceId }, key: path, data: { path, expanded: new Set() } });
  }
  ctx.provide('miniFileTree', { open });
  ctx.miniTabs.contribute('files', {
    title: 'Workspace files',
    icon: 'files',
    description: 'Browse files and folders.',
    open: (scope) => open('.', scope),
  });
  ctx.effect(() => fileCompletion(ctx));
}

export default {
  inject: ['harnessBrowser', 'miniProjections', 'miniTabs', 'miniComposer'],
  provide: ['miniFileTree'],
  apply: setup,
};
