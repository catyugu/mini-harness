import type {} from '@mini-harness/plugin-api/scopes';
import type {} from '@mini-harness/sessions/records';
import type {} from '@mini-harness/tools/api';
import type {} from '@mini-harness/workspaces/api';
import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/file-access/api';
import { DomainError } from '@mini-harness/platform/errors';
import { relative, resolve, sep } from 'node:path';
import type { Context } from 'mini-harness/cordis';
import { Inspection } from './inspection.js';
import { fileTools, fileToolNames } from './tools.js';
import type { RouteRequest } from '@mini-harness/transport/routes';

export function setup(ctx: Context) {
  const { harnessWorkspaces: workspaces,
    harnessRoutes: routes, harnessChanges: changes } = ctx;
  const sessions = ctx.harnessSessions.access();
  ctx.effect(() => changes.register('files'));

  for (const [index, name] of fileToolNames.entries()) {
    const writes = name === 'edit' || name === 'write';
    ctx.effect(() => ctx.harnessTools.register({ name, bind(id) {
      const root = sessions.workspacePath(id);
      const session = sessions.get(id);
      if (!session) throw new DomainError('not_found', 'Conversation not found');
      const tool = fileTools(root, () => ctx.harnessScopes.require(`session:${id}`, 'harnessFileAccess').open(session.workspaceId))[index];
      return {
        ...tool,
        async execute(...args: Parameters<typeof tool.execute>) {
          const result = await tool.execute(...args);
          if (!writes) return result;
          const path = (args[1] as { path?: unknown })?.path;
          if (typeof path !== 'string') return result;
          changes.invalidate('files', { workspaceId: session.workspaceId });
          const changedPath = relative(root, resolve(root, path)).split(sep).join('/');
          const details = typeof result.details === 'object' ? result.details : undefined;
          return { ...result, details: { ...details, changedPath } };
        }
      };
    } }, { access: writes ? 'standard' : 'readOnly' }));
  }

  const inspection = async ({ params, url, signal }: RouteRequest) => {
    const workspace = workspaces.get(params.id);
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId && sessions.get(sessionId)?.workspaceId !== workspace.id) throw new DomainError('not_found', 'Conversation not found');
    if (sessionId) await ctx.harnessScopes.prepare(`session:${sessionId}`, signal);
    const access = sessionId ? ctx.harnessScopes.require(`session:${sessionId}`, 'harnessFileAccess') : ctx.harnessFileAccess;
    return new Inspection(workspaces.resolveRoot(workspace.path, workspace.id), access.open(workspace.id), signal);
  };
  const path = ({ url }: RouteRequest) => url.searchParams.get('path') ?? '.';
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/tree', async (req) => (await inspection(req)).tree(path(req))));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/search', async (req) =>
    (await inspection(req)).files.searchFiles(req.url.searchParams.get('q') ?? '', req.signal)));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/preview', async (req) => (await inspection(req)).preview(path(req))));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/changes', async (req) => (await inspection(req)).changes()));
  ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/diff', async (req) => (await inspection(req)).diff(path(req))));
}
