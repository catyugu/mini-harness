import { relative, resolve, sep } from 'node:path';
import type { Context } from 'cordis';
import { Inspection } from './inspection.js';
import { fileTools, fileToolNames } from './tools.js';
import type { RouteRequest } from '../contracts/routes.js';

export function setup(ctx: Context) {
  const { harnessFileAccess: files, harnessRegistry: sessions, harnessWorkspaces: workspaces,
    harnessTools: tools, harnessRoutes: routes } = ctx;

  for (const [index, name] of fileToolNames.entries()) {
    ctx.effect(() => tools.register(name, (id) => {
      const root = sessions.workspacePath(id);
      const tool = fileTools(root, files.open(sessions.get(id).workspaceId))[index];
      if (name !== 'edit' && name !== 'write') return tool;
      return {
        ...tool,
        async execute(...args: Parameters<typeof tool.execute>) {
          const result = await tool.execute(...args);
          const path = (args[1] as { path?: unknown })?.path;
          if (typeof path !== 'string') return result;
          const changedPath = relative(root, resolve(root, path)).split(sep).join('/');
          const details = typeof result.details === 'object' ? result.details : undefined;
          return { ...result, details: { ...details, changedPath } };
        }
      };
    }, undefined, true));
  }

  const inspection = ({ params, url }: RouteRequest) => {
    const workspace = workspaces.get(params.id);
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId && sessions.get(sessionId)?.workspaceId !== workspace.id) throw new Error('Conversation not found');
    return new Inspection(workspaces.resolveRoot(workspace.path, workspace.id), files.open(workspace.id));
  };
  const path = ({ url }: RouteRequest) => url.searchParams.get('path') ?? '.';
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/tree', (req) => inspection(req).tree(path(req))));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/search', (req) =>
    inspection(req).files.searchFiles(req.url.searchParams.get('q') ?? '', req.signal)));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/preview', (req) => inspection(req).preview(path(req))));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/changes', (req) => inspection(req).changes()));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/diff', (req) => inspection(req).diff(path(req))));
}
