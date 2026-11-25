import type { Context } from 'mini-harness/cordis';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { Conversation } from '../shared/api.ts';

export function projectSession(
  ctx: Pick<Context, 'harnessSessions' | 'harnessRuns' | 'harnessApprovals'>,
  record: SessionRecord,
): Conversation {
  const run = ctx.harnessRuns.info(record.id);
  const modified = ctx.harnessSessions.modifiedAt(record);
  const updatedAt = [modified, run?.finishedAt ?? run?.startedAt ?? ''].sort().at(-1) ?? modified;
  return { ...record, updatedAt, run, waitingApproval: ctx.harnessApprovals.has(record.id) };
}
