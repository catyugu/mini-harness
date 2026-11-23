import type { Context } from 'cordis';
import type { SessionRecord, Conversation } from '@mini-harness/contracts/conversation';

export function projectSession(ctx: Pick<Context, 'harnessRegistry' | 'harnessRuns' | 'harnessApprovals'>, record: SessionRecord): Conversation {
  const run = ctx.harnessRuns.info(record.id);
  const modified = ctx.harnessRegistry.modifiedAt(record);
  const updatedAt = [modified, run?.finishedAt ?? run?.startedAt ?? ''].sort().at(-1) ?? modified;
  return { ...record, updatedAt, run, waitingApproval: ctx.harnessApprovals.has(record.id) };
}
