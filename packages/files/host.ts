import { relative, resolve, sep } from 'node:path';
import type { Context } from 'cordis';
import { Inspection } from './inspection.js';
import { fileTools, fileToolNames } from './tools.js';
import type { RouteRequest } from '../contracts/routes.js';

export function setup(ctx: Context) {
  const { harnessFileAccess: files, harnessRegistry: sessions, harnessWorkspaces: workspaces,
    harnessTools: tools, harnessRoutes: routes, harnessScopes: scopes } = ctx;

  for (const [index, name] of fileToolNames.entries()) {
    ctx.effect(() => tools.register(name, (id) => {
      const root = sessions.workspacePath(id);
      const access = scopes.resolve<Context['harnessFileAccess']>(id, 'harnessFileAccess') ?? files;
      const tool = fileTools(root, access.open(sessions.get(id).workspaceId))[index];
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
    }));
  }

  const inspection = async ({ params, url, signal }: RouteRequest) => {
    const workspace = workspaces.get(params.id);
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId && sessions.get(sessionId)?.workspaceId !== workspace.id) throw new Error('Conversation not found');
    if (sessionId) await scopes.prepare(sessionId, signal);
    const access = sessionId ? scopes.resolve<Context['harnessFileAccess']>(sessionId, 'harnessFileAccess') ?? files : files;
    return new Inspection(workspaces.resolveRoot(workspace.path, workspace.id), access.open(workspace.id));
  };
  const path = ({ url }: RouteRequest) => url.searchParams.get('path') ?? '.';
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/tree', async (req) => (await inspection(req)).tree(path(req))));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/search', async (req) =>
    (await inspection(req)).files.searchFiles(req.url.searchParams.get('q') ?? '', req.signal)));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/preview', async (req) => (await inspection(req)).preview(path(req))));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/changes', async (req) => (await inspection(req)).changes()));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/diff', async (req) => (await inspection(req)).diff(path(req))));
}
