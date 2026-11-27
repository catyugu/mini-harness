import type { WorkspaceView } from '@mini-harness/workspaces/browser/file-views';
import type { Context } from 'mini-harness/cordis';
import type { ToolView } from '@mini-harness/conversation/browser/history-api';
import { rasterImage, textOutput } from '@mini-harness/ui-primitives/primitives';
import { fileCompletion } from './completion.ts';
import { fileTree } from './tree.ts';

function fileTarget({ name, arguments: args }: ToolView) {
  if (!args || typeof args !== 'object') return;
  const input = args as Record<string, unknown>;
  const path = typeof input.path === 'string' ? input.path : undefined;
  let subject: string;
  let detail = '';
  if (name === 'find' || name === 'grep') {
    if (typeof input.pattern !== 'string') return;
    subject = input.pattern;
    detail = ' in ' + (path ?? '.');
    if (name === 'grep' && typeof input.glob === 'string') detail += ' (' + input.glob + ')';
  } else {
    if (path === undefined && name !== 'ls') return;
    subject = path ?? '.';
    if (name === 'read') {
      if (typeof input.offset === 'number') detail += ' · offset ' + input.offset;
      if (typeof input.limit === 'number') detail += ' · limit ' + input.limit;
    }
  }
  const node = document.createElement('span');
  node.className = 'file-tool-target';
  const primary = document.createElement('code');
  primary.textContent = subject;
  node.append(primary, detail);
  return node;
}

function fileSummary(tool: ToolView) {
  const node = fileTarget(tool);
  node?.classList.add('ui-truncate');
  return node;
}

function fileBody(tool: ToolView) {
  const node = document.createElement('div');
  node.className = 'file-tool-body';
  const target = fileTarget(tool);
  if (target) node.append(target);
  const args = tool.arguments;
  if (args && typeof args === 'object') {
    if (tool.name === 'write' && 'content' in args && typeof args.content === 'string') {
      const label = document.createElement('span');
      label.textContent = 'Requested content';
      node.append(label, textOutput(args.content));
    }
    if (tool.name === 'edit' && 'edits' in args && Array.isArray(args.edits)) {
      const label = document.createElement('span');
      label.textContent = 'Requested edits';
      node.append(label);
      for (const edit of args.edits) {
        if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') continue;
        const before = textOutput(edit.oldText);
        before.classList.add('file-edit-before');
        before.setAttribute('aria-label', 'Before');
        const after = textOutput(edit.newText);
        after.classList.add('file-edit-after');
        after.setAttribute('aria-label', 'After');
        node.append(before, after);
      }
    }
  }
  if (typeof tool.content === 'string') node.append(textOutput(tool.content));
  else for (const block of tool.content ?? []) {
    if (block.type === 'text' && block.text) node.append(textOutput(block.text));
    if (block.type === 'image') {
      const image = rasterImage(block.mimeType, block.data, 'File image');
      if (image) node.append(image);
    }
  }
  return node;
}

function setup(ctx: Context) {
  ctx.inject(['miniMessages'], (history) => {
    for (const name of ['read', 'write', 'edit', 'ls', 'find', 'grep']) {
      history.effect(() => history.miniMessages.registerTool(name, fileSummary, 'summary'));
      history.effect(() => history.miniMessages.registerTool(name, fileBody, 'body'));
    }
  });
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
