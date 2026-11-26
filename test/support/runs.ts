import type { Context } from 'mini-harness/cordis';
import type { RunPort, RunSubmission } from '@mini-harness/runs/api';
import type { StreamEvent } from '@mini-harness/runs/stream';
import type { InputSource } from '@mini-harness/input/message';

export async function sendRun(
  runs: RunPort,
  id: string,
  message: string,
  emit?: (event: StreamEvent) => void,
  { source = 'user', ...options }: Omit<RunSubmission, 'message'> & { source?: InputSource } = {},
) {
  for (let current = runs.current(id); current; current = runs.current(id))
    await current.result.catch(() => {});
  const receipt = runs.send(id, { message, origin: { source }, ...options });
  const task = runs.current(id);
  if (!task || task.id !== receipt.taskId) throw new Error('No active run for accepted input');
  const stop = emit && runs.watch(id, task.id, 0, emit);
  try {
    return (await task.result) as string;
  } finally {
    stop?.();
  }
}

export function activeRunCount(ctx: Pick<Context, 'harnessRuns' | 'harnessSessions'>) {
  return ctx.harnessSessions.list().filter(({ id }) => ctx.harnessRuns.current(id)).length;
}
