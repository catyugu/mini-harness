import { workspaceFiles } from '@mini-harness/file-access/request';
import type {} from '@mini-harness/transport/routes';
import type { Context } from 'mini-harness/cordis';
import { GitInspection } from './git.js';

export function setup(ctx: Context) {
  const { harnessRoutes: routes } = ctx;
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/changes', async req => {
    const { root, files } = await workspaceFiles(ctx, req);
    return new GitInspection(root, files, req.signal).changes();
  }));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/diff', async req => {
    const { root, files, path } = await workspaceFiles(ctx, req);
    return new GitInspection(root, files, req.signal).diff(path);
  }));
}
