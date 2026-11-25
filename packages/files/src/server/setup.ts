import { DomainError } from '@mini-harness/platform/errors';
import { relative, resolve, sep } from 'node:path';
import type { Context } from 'mini-harness/cordis';
import { workspaceFiles } from '@mini-harness/file-access/request';
import { fileTools, fileToolNames } from './tools.ts';

export function setup(ctx: Context) {
  const { harnessChanges: changes } = ctx;
  const sessions = ctx.harnessSessions;

  for (const [index, name] of fileToolNames.entries()) {
    const writes = name === 'edit' || name === 'write';
    ctx.effect(() =>
      ctx.harnessTools.register(
        {
          name,
          bind(id) {
            const root = sessions.workspacePath(id);
            const session = sessions.get(id);
            if (!session) throw new DomainError('not_found', 'Conversation not found');
            const tool = fileTools(root, () =>
              ctx.harnessScopes.require(`session:${id}`, 'harnessFileAccess').open(session.workspaceId),
            )[index];
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
              },
            };
          },
        },
        { access: writes ? 'standard' : 'readOnly' },
      ),
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
        const { files } = await workspaceFiles(ctx, req);
        return files.searchFiles(req.url.searchParams.get('q') ?? '', req.signal);
      }),
    );
  });
}
