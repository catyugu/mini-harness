import { addAbortListener } from 'node:events';

/** Cancel a caller's wait while the owner continues to settle the operation. */
export async function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    throw signal.reason;
  }
  let listener: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        listener = addAbortListener(signal, () => reject(signal.reason));
      }),
    ]);
  } finally {
    listener?.[Symbol.dispose]();
  }
}
