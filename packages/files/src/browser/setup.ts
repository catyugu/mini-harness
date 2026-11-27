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
  return { subject, detail };
}

function targetView() {
  const node = document.createElement('span');
  node.className = 'file-tool-target';
  const primary = document.createElement('code');
  const secondary = document.createTextNode('');
  node.append(primary, secondary);
  let previous: unknown = Symbol();
  return {
    node,
    update(tool: ToolView) {
      if (previous === tool.arguments) return;
      previous = tool.arguments;
      const target = fileTarget(tool);
      node.hidden = !target;
      if (!target) return;
      if (primary.textContent !== target.subject) primary.textContent = target.subject;
      if (secondary.data !== target.detail) secondary.data = target.detail;
    },
  };
}

function fileSummary() {
  const view = targetView();
  view.node.classList.add('ui-truncate');
  return view;
}

function fileBody() {
  const node = document.createElement('div');
  node.className = 'file-tool-body';
  const target = targetView();
  const input = document.createElement('div');
  const result = document.createElement('div');
  node.append(target.node, input, result);
  let previousArgs: unknown = Symbol();
  let previousContent: ToolView['content'];
  let previousInput: string | undefined;
  function updateInput(tool: ToolView) {
    const args = tool.arguments;
    if (previousArgs === args) return;
    previousArgs = args;
    target.update(tool);
    const fields = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    const content = tool.name === 'write' && typeof fields.content === 'string' ? fields.content : undefined;
    const edits: { oldText: string; newText: string }[] =
      tool.name === 'edit' && Array.isArray(fields.edits)
        ? fields.edits.flatMap((edit) =>
            edit && typeof edit.oldText === 'string' && typeof edit.newText === 'string'
              ? [{ oldText: edit.oldText, newText: edit.newText }]
              : [],
          )
        : [];
    const key = JSON.stringify([content, edits]);
    if (previousInput === key) return;
    previousInput = key;
    input.replaceChildren();
    if (content !== undefined) {
      const label = document.createElement('span');
      label.textContent = 'Requested content';
      input.append(label, textOutput(content));
    }
    if (edits.length) {
      const label = document.createElement('span');
      label.textContent = 'Requested edits';
      input.append(label);
      for (const edit of edits) {
        const before = textOutput(edit.oldText);
        before.classList.add('file-edit-before');
        before.setAttribute('aria-label', 'Before');
        const after = textOutput(edit.newText);
        after.classList.add('file-edit-after');
        after.setAttribute('aria-label', 'After');
        input.append(before, after);
      }
    }
    input.hidden = !input.childElementCount;
  }
  function updateResult(tool: ToolView) {
    if (previousContent === tool.content) return;
    previousContent = tool.content;
    const blocks =
      typeof tool.content === 'string'
        ? [{ type: 'text' as const, text: tool.content }]
        : (tool.content ?? []);
    const children: HTMLElement[] = [];
    for (const block of blocks) {
      const existing = result.children[children.length];
      if (block.type === 'text' && block.text) {
        const output = existing instanceof HTMLPreElement ? existing : textOutput('');
        if (output.textContent !== block.text) output.textContent = block.text;
        children.push(output);
      }
      if (block.type === 'image') {
        const image = rasterImage(block.mimeType, block.data, 'File image');
        if (image)
          children.push(
            existing instanceof HTMLImageElement && existing.src === image.src ? existing : image,
          );
      }
    }
    for (const [index, child] of children.entries())
      if (result.children[index] !== child) result.insertBefore(child, result.children[index] ?? null);
    while (result.children.length > children.length) result.lastElementChild!.remove();
    result.hidden = !children.length;
  }
  input.hidden = result.hidden = true;
  return {
    node,
    update(tool: ToolView) {
      updateInput(tool);
      updateResult(tool);
    },
  };
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
