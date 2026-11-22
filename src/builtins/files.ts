import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { relative, resolve, sep } from 'node:path';
import type { Context } from 'cordis';
import { Inspection } from '../inspection.js';
import type { BuiltinPlugin } from '../plugins.js';

export const files: BuiltinPlugin = {
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  icon: 'files', browser: '/builtins/files.js', inject: ['harnessState', 'harnessTools', 'harnessRoutes'],
  setup(ctx: Context) {
    const { cwd, home } = ctx.harnessState.paths;
    const inspection = new Inspection(cwd, home);
    const definitions: ToolDefinition[] = inspection.files.tools();
    for (const tool of definitions) {
      const writes = tool.name === 'edit' || tool.name === 'write';
      const definition = !writes ? tool : {
        ...tool,
        async execute(...args: Parameters<typeof tool.execute>) {
          const result = await tool.execute(...args);
          const path = (args[1] as { path?: unknown })?.path;
          if (typeof path !== 'string') return result;
          const changedPath = relative(cwd, resolve(cwd, path)).split(sep).join('/');
          const details = typeof result.details === 'object' ? result.details : undefined;
          return { ...result, details: { ...details, changedPath } };
        }
      };
      ctx.effect(() => ctx.harnessTools.register(definition, undefined, undefined, true));
    }
    const { harnessRoutes: routes } = ctx;
    ctx.effect(() => routes.register('GET', '/api/files/tree', ({ url }) => inspection.tree(url.searchParams.get('path') ?? '.')));
    ctx.effect(() => routes.register('GET', '/api/files/search', ({ url }) => inspection.files.searchFiles(url.searchParams.get('q') ?? '')));
    ctx.effect(() => routes.register('GET', '/api/files/preview', ({ url }) => inspection.preview(url.searchParams.get('path') ?? '.')));
    ctx.effect(() => routes.register('GET', '/api/files/changes', () => inspection.changes()));
    ctx.effect(() => routes.register('GET', '/api/files/diff', ({ url }) => inspection.diff(url.searchParams.get('path') ?? '.')));
  }
};
