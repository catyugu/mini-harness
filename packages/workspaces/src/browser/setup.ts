import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import type { WorkspaceRecord } from '../shared/record.ts';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

const setup = async (ctx: Context) => {
  const store = new RemoteStore(() => browserRequest<WorkspaceRecord[]>(ctx, '/workspaces'));
  await store.refresh();
  ctx.effect(() => ctx.miniProjections.register('workspaces', store));
  ctx.provide('miniWorkspaces', store);
};

export default { inject: ['miniProjections'], provide: ['miniWorkspaces'], apply: setup };
