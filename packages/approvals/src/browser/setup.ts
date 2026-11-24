import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/ui-runtime/projection-api';
import type { Approval } from '../shared/request.js';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

const setup = async (ctx: Context) => {
  const store = new RemoteStore(() => browserRequest<Approval[]>(ctx, '/approvals'));
  await store.refresh();
  ctx.effect(() => ctx.miniProjections.register('approvals', store));
  ctx.provide('miniApprovals', store);
};

export default { inject: ['miniProjections'], provide: ['miniApprovals'], apply: setup };
