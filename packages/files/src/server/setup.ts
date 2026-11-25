import { DomainError } from '@mini-harness/platform/errors';
import { relative, resolve, sep } from 'node:path';
import type { Context } from 'mini-harness/cordis';
import { workspaceFiles } from '@mini-harness/workspaces/file-request';
import { fileTools, fileToolNames } from './tools.ts';
import { WorkspaceSearch } from './search.ts';
import { containsPath } from '@mini-harness/platform/paths';
import { realpathSync } from 'node:fs';

export function setup(ctx: Context) {
  const { harnessChanges: changes } = ctx;
  ctx.effect(() => changes.register('files'));
  const sessions = ctx.harnessSessions;
  const state = realpathSync.native(ctx.harnessState.paths.home);

  for (const [index, name] of fileToolNames.entries()) {
    const writes = name === 'edit' || name === 'write';
    ctx.effect(() =>
      ctx.harnessTools.register({
        name,
        resolve(id) {
          const root = sessions.workspacePath(id);
          const session = sessions.get(id);
          if (!session) throw new DomainError('not_found', 'Conversation not found');
          const tool = fileTools(root, () =>
            ctx.harnessProfileScopes
              .require(`session:${id}`, 'harnessFileAccess')
              .open(root, { exclude: (path) => containsPath(state, path) }),
          )[index];
          return {
            ...tool,
            tags: writes ? undefined : ['readOnly'],
            async execute(...args: Parameters<typeof tool.execute>) {
              const result = await tool.execute(...args);
              if (!writes) return result;
              const path = (args[1] as { path?: unknown })?.path;
              if (typeof path !== 'string') return result;
              changes.invalidate('files', session.workspaceId);
              const changedPath = relative(root, resolve(root, path)).split(sep).join('/');
              const details = typeof result.details === 'object' ? result.details : undefined;
              return { ...result, details: { ...details, changedPath } };
            },
          };
        },
      }),
    );
  }

  ctx.inject(['harnessRoutes'], (web) => {
    web.effect(() =>
      web.harnessRoutes.register('GET', '/api/workspaces/:id/files/tree', async (req) => {
        const { files, root, path } = await workspaceFiles(ctx, req);
        return (await files.entries(resolve(root, path))).filter(({ name }) => name !== '.git');
      }),
    );
    web.effect(() =>
      web.harnessRoutes.register('GET', '/api/workspaces/:id/files/search', async (req) => {
        const { files, root } = await workspaceFiles(ctx, req);
        return new WorkspaceSearch(root, files).searchFiles(req.url.searchParams.get('q') ?? '', req.signal);
      }),
    );
  });
}
