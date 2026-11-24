export function pluginInvocation(lifetime: AbortSignal, instanceId: string) {
  const active = new Set<Promise<unknown>>();

  return {
    async run<T>(stage: string, work: (signal: AbortSignal) => T | Promise<T>, request?: AbortSignal): Promise<T> {
      const signal = request ? AbortSignal.any([lifetime, request]) : lifetime;
      const pending = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work(signal);
      });
      active.add(pending);
      try {
        const result = await pending;
        signal.throwIfAborted();
        return result;
      } catch (error) {
        request?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error('Plugin ' + instanceId + ' failed during ' + stage + ': ' + message, { cause: error });
      } finally { active.delete(pending); }
    },
    async drain() { await Promise.allSettled(active); }
  };
}
