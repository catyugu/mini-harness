import { workspaceFiles } from '@mini-harness/file-access/request';
import type { Context } from 'mini-harness/cordis';
import { downloadWorkspaceFile, workspacePreview } from './preview.ts';

export function setup(ctx: Context) {
  const { harnessRoutes: routes } = ctx;
  ctx.effect(() =>
    routes.register('GET', '/api/workspaces/:id/files/preview', async (req) => {
      const { files, path } = await workspaceFiles(ctx, req);
      return workspacePreview(files, path, req.signal);
    }),
  );
  ctx.effect(() =>
    routes.register('GET', '/api/workspaces/:id/files/download', async (req) => {
      const { files, path } = await workspaceFiles(ctx, req);
      return downloadWorkspaceFile(files, path, req.signal);
    }),
  );
}
