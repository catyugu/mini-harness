export interface TaskJob {
  parallel?: boolean;
  run(signal: AbortSignal): Promise<void>;
}

/** Serial jobs are barriers. A failed job cancels the batch and drains started jobs. */
export async function runBatch(
  jobs: Iterable<TaskJob>,
  { signal, limit }: { signal: AbortSignal; limit: number },
) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid parallel limit');
  const controller = new AbortController();
  const cancellation = AbortSignal.any([signal, controller.signal]);
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    if (failure) return;
    failure = { error };
    controller.abort(error);
  };
  const start = (job: TaskJob) => {
    const work = Promise.resolve()
      .then(() => job.run(cancellation))
      .catch(fail)
      .finally(() => active.delete(work));
    active.add(work);
    return work;
  };
  try {
    for (const job of jobs) {
      if (failure) break;
      if (job.parallel) {
        start(job);
        if (active.size === limit) await Promise.race(active);
      } else {
        await Promise.all(active);
        if (failure) break;
        await start(job);
      }
    }
  } catch (error) {
    fail(error);
  }
  await Promise.all(active);
  if (failure) throw failure.error;
}
