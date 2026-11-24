import { sessionExtensions } from '@mini-harness/sessions/records';
import type {} from '@mini-harness/workspaces/api';
import type { ScopeTarget } from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/file-access/api';
import { DomainError } from '@mini-harness/platform/errors';
import { relative, resolve, sep } from 'node:path';
import { toolExtensions } from '@mini-harness/tools/extensions';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';
import type { Context } from 'cordis';
import { Inspection } from './inspection.js';
import { fileTools, fileToolNames } from './tools.js';
import type { RouteRequest } from '@mini-harness/transport/routes';

export function setup(ctx: Context, api: PluginApi) {
  const sessions = api.contribute(sessionExtensions.access);
  const workspaces = api.service('harnessWorkspaces');
  const { harnessRoutes: routes, harnessChanges: changes } = ctx;
  ctx.effect(() => changes.register('files'));

  for (const [index, name] of fileToolNames.entries()) {
    const writes = name === 'edit' || name === 'write';
    api.contribute(toolExtensions.register, { name, bind(id) {
      const root = sessions.workspacePath(id);
      const access = api.scopedService({ kind: 'session', sessionId: id }, 'harnessFileAccess');
      const session = sessions.get(id);
      if (!session) throw new DomainError('not_found', 'Conversation not found');
      const tool = fileTools(root, access.open(session.workspaceId))[index];
      if (!writes) return tool;
      return {
        ...tool,
        async execute(...args: Parameters<typeof tool.execute>) {
          const result = await tool.execute(...args);
          const path = (args[1] as { path?: unknown })?.path;
          if (typeof path !== 'string') return result;
          changes.invalidate('files', { workspaceId: session.workspaceId });
          const changedPath = relative(root, resolve(root, path)).split(sep).join('/');
          const details = typeof result.details === 'object' ? result.details : undefined;
          return { ...result, details: { ...details, changedPath } };
        }
      };
    } }, { access: writes ? 'standard' : 'readOnly' });
  }

  const inspection = async ({ params, url, signal }: RouteRequest) => {
    const workspace = workspaces.get(params.id);
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId && sessions.get(sessionId)?.workspaceId !== workspace.id) throw new DomainError('not_found', 'Conversation not found');
    const target: ScopeTarget = sessionId ? { kind: 'session', sessionId } : { kind: 'workspace', workspaceId: workspace.id };
    await api.prepareScope(target, signal);
    const access = api.scopedService(target, 'harnessFileAccess');
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
