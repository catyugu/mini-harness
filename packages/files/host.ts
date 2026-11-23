import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { relative, resolve, sep } from 'node:path';
import type { Context } from 'cordis';
import { Inspection } from './inspection.js';
import type { RouteRequest } from '../../src/contracts/routes.js';


export function setup(ctx: Context) {
    const { home, cwd } = ctx.harnessState.paths;
    let cachedRoot: string;
    let definitions: ToolDefinition[];
    function tools(root: string) {
      if (cachedRoot !== root) {
        definitions = new Inspection(root, home, true).files.tools();
        cachedRoot = root;
      }
      return definitions;
    }
    for (const [index, { name }] of tools(cwd).entries()) {
      ctx.effect(() => ctx.harnessTools.register(name, (id) => {
        const root = ctx.harnessWorkspace.resolve(id);
        const tool = tools(root)[index];
        if (tool.name !== 'edit' && tool.name !== 'write') return tool;
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
    const { harnessRoutes: routes } = ctx;
    const inspection = ({ params, url }: RouteRequest) => {
      const workspace = ctx.harnessWorkspaces.get(params.id);
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId && ctx.harnessRegistry.get(sessionId)?.workspaceId !== workspace.id)
        throw new Error('Conversation not found');
      return new Inspection(ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id), home, true);
    };
    const path = ({ url }: RouteRequest) => url.searchParams.get('path') ?? '.';
    ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/tree', (req) => inspection(req).tree(path(req))));
    ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/search', (req) => inspection(req).files.searchFiles(req.url.searchParams.get('q') ?? '')));
    ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/preview', (req) => inspection(req).preview(path(req))));
    ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/changes', (req) => inspection(req).changes()));
    ctx.effect(() => routes.register('GET', '/api/workspaces/:id/files/diff', (req) => inspection(req).diff(path(req))));
}
