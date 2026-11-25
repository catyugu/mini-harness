import { fileRoute } from '@mini-harness/file-access/browser/views';
import type { Suggestion } from '@mini-harness/conversation/browser/composer-api';
import type {} from '@mini-harness/conversation/browser/navigation-api';
import { browserRequest, wait } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import { readDirectory } from './tree.js';

export function fileCompletion(ctx: Context) {
  const services = ctx.harnessBrowser;
  return ctx.miniComposer.completion('@', async ({ query, signal, show, replace }) => {
    const scope = services.workspace();
    if (!scope) return;
    if (query.startsWith('"')) return;
    const reference = (path: string) => replace('@' + JSON.stringify(path));
    if (query) {
      await wait(120, signal);
      if (signal.aborted) return;
      const paths = await browserRequest<string[]>(ctx, fileRoute(scope, '/files/search', { q: query }), { signal });
      show(paths.map((path) => ({ label: path, icon: 'file', run: () => reference(path) })), 'No matching files.');
      return;
    }
    const listing = new Map<string, Awaited<ReturnType<typeof readDirectory>>>();
    const open = new Set<string>();
    const loading = new Set<string>();
    const options = (path: string, depth = 0): Suggestion[] => (listing.get(path) ?? []).flatMap<Suggestion>((entry) => {
      if (!entry.directory) return [{ label: entry.name, icon: 'file', depth, run: () => reference(entry.path) }];
      const expanded = open.has(entry.path);
      const row: Suggestion = { label: entry.name, icon: expanded ? 'folder-open' : 'folder', expanded, depth, run: (complete) => {
        if (complete) { reference(entry.path + '/'); return; }
        if (loading.has(entry.path)) return;
        if (expanded) { open.delete(entry.path); draw(); }
        else void expand(entry.path).catch((error) => { if (!signal.aborted) services.report(error); });
      } };
      return expanded ? [row, {
        label: 'Reference ' + entry.name + '/', icon: 'folder', depth: depth + 1, run: () => reference(entry.path + '/')
      }, ...options(entry.path, depth + 1)] : [row];
    });
    const draw = () => show(options('.'), 'This directory is empty.');
    const expand = async (path: string) => {
      loading.add(path);
      try {
        if (!listing.has(path)) listing.set(path, await readDirectory(ctx, scope, path, signal));
        open.add(path);
        draw();
      } finally { loading.delete(path); }
    };
    await expand('.');
  });
}
