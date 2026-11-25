import { fileRoute, refreshOnFileChange } from '@mini-harness/file-access/browser/views';
import { button, iconButton } from '@mini-harness/ui-primitives/primitives';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';

interface GitChange {
  path: string;
  status: string;
}
interface Changes {
  available: boolean;
  files: GitChange[];
  truncated?: boolean;
  reason?: string;
}
interface Diff {
  content: string;
  truncated?: boolean;
}

function inspect<T>(
  signal: AbortSignal,
  title: string,
  fetch: (signal: AbortSignal) => Promise<T>,
  render: (data: T, content: HTMLElement) => void,
) {
  const root = document.createElement('section');
  const head = document.createElement('header');
  head.className = 'git-inspection-header';
  const name = document.createElement('strong');
  name.textContent = title;
  const refresh = iconButton('Refresh ' + title, 'refresh');
  head.append(name, refresh);
  const content = document.createElement('div');
  root.append(head, content);
  let request: AbortController;
  async function load() {
    request?.abort();
    request = new AbortController();
    const lifetime = AbortSignal.any([signal, request.signal]);
    content.setAttribute('aria-busy', 'true');
    try {
      const result = await fetch(lifetime);
      if (lifetime.aborted) return;
      content.replaceChildren();
      render(result, content);
    } catch (error) {
      if (!lifetime.aborted) content.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (!lifetime.aborted) content.removeAttribute('aria-busy');
    }
  }
  refresh.onclick = () => void load();
  void load();
  return { root, load };
}

function setup(ctx: Context) {
  const tabs = ctx.miniTabs;
  const diff = tabs.register<string>('diff', {
    title: (path) => 'Diff: ' + (path.split('/').at(-1) ?? path),
    create(path, scope, signal) {
      const { root, load } = inspect<Diff>(
        signal,
        path,
        (signal) => browserRequest(ctx, fileRoute(scope, '/files/diff', { path }), { signal }),
        ({ content, truncated }, body) => {
          const pre = document.createElement('pre');
          pre.className = 'diff';
          const lines = content.trimEnd().split('\n');
          for (const line of lines.slice(0, 5000)) {
            const span = document.createElement('span');
            span.className = line.startsWith('@@')
              ? 'diff-hunk'
              : /^(?:diff |index |--- |\+\+\+ )/.test(line)
                ? 'diff-header'
                : line.startsWith('+')
                  ? 'added'
                  : line.startsWith('-')
                    ? 'removed'
                    : '';
            span.textContent = line + '\n';
            pre.append(span);
          }
          if (truncated || lines.length > 5000) pre.append('… Diff is truncated.');
          body.append(pre);
        },
      );
      refreshOnFileChange(ctx, scope, root, signal, load);
      return root;
    },
  });
  const changes = tabs.register('changes', {
    title: () => 'Git changes',
    create(_data, scope, signal) {
      const { root, load } = inspect<Changes>(
        signal,
        'Git changes',
        (signal) => browserRequest(ctx, fileRoute(scope, '/files/changes'), { signal }),
        ({ files, reason, truncated }, body) => {
          for (const { path, status } of files) {
            const row = button(path, 'quiet');
            row.classList.add('git-change');
            row.title = path;
            const state = document.createElement('span');
            state.textContent = status;
            state.title =
              status === '??'
                ? 'Untracked'
                : `Staged: ${status[0].trim() || '–'}, working tree: ${status[1].trim() || '–'}`;
            row.append(state);
            row.onclick = () =>
              diff.open({ owner: { workspaceId: scope.workspaceId }, key: path, data: path });
            body.append(row);
          }
          if (!files.length) body.append(reason ?? 'No Git changes.');
          if (truncated) body.append('Git status is truncated.');
        },
      );
      refreshOnFileChange(ctx, scope, root, signal, load);
      return root;
    },
  });
  tabs.contribute('changes', {
    title: 'Git changes',
    icon: 'list-checks',
    description: 'Inspect changes in this repository.',
    order: 10,
    open: ({ workspaceId }) => changes.open({ owner: { workspaceId }, key: 'changes', data: undefined }),
  });
}

export default { inject: ['miniTabs', 'miniProjections'], provide: [], apply: setup };
