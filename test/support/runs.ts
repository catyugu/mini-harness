import type { Context } from 'mini-harness/cordis';
import type { RunInput, RunPort, RunSubmission } from '@mini-harness/runs/api';
import type { StreamEvent } from '@mini-harness/runs/stream';

/** Submit a user input and await its actual task, including synchronous admission errors. */
export async function sendRun(
  runs: RunPort,
  id: string,
  message: string,
  emit?: (event: StreamEvent) => void,
  options: Omit<RunInput, 'message'> & RunSubmission = {},
) {
  const { model, attachments, thinkingLevel, ...submission } = options;
  return runs.submit(id, { message, model, attachments, thinkingLevel }, { source: 'user', ...submission, emit })
    .result;
}

export function activeRunCount(ctx: Pick<Context, 'harnessRuns' | 'harnessSessions'>) {
  return ctx.harnessSessions.list().filter(({ id }) => ctx.harnessRuns.current(id)).length;
}
