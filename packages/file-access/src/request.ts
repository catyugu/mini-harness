import { DomainError } from '@mini-harness/platform/errors';
import type { RouteRequest } from '@mini-harness/transport/routes';
import type { Context } from 'mini-harness/cordis';

/** Resolve the same scoped file policy for every authenticated workspace file route. */
export async function workspaceFiles(ctx: Context, { params, url, signal }: RouteRequest) {
  const workspace = ctx.harnessWorkspaces.get(params.id);
  const scopes = ctx.harnessScopes;
  const session = url.searchParams.get('sessionId');
  const owner = `workspace:${workspace.id}` as const;
  const key = session ? (`session:${session}` as const) : owner;
  if (session && !scopes.address(key).includes(owner))
    throw new DomainError('not_found', 'Conversation not found');
  await scopes.prepare(key, signal);
  return {
    files: scopes.require(key, 'harnessFileAccess').open(workspace.id),
    root: ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id),
    path: url.searchParams.get('path') ?? '.',
  };
}
