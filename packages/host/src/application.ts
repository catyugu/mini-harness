import { Context } from 'mini-harness/cordis';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { LaunchOptions } from '@mini-harness/plugin-api/profile';
import { loadProfile } from './profile.js';

/** The launcher supplies process state and loads the selected Profile onto a fresh Cordis tree. */
export async function bootProfile(name: string, paths: Paths, launch: LaunchOptions) {
  const ctx = new Context();
  const profile = await loadProfile(name, paths, ctx);
  ctx.provide('harnessState', { paths });
  ctx.provide('harnessProfile', profile);
  ctx.provide('harnessLaunch', launch);
  let stopping: Promise<void> | undefined;
  const close = () =>
    (stopping ??= (async () => {
      ctx.emit('harness/seal');
      try {
        await ctx.parallel('harness/quiesce');
      } finally {
        try {
          await ctx.parallel('harness/drain');
        } finally {
          await profile.close();
        }
      }
    })());
  try {
    const errors = await profile.entries.update(profile.nativeEntries);
    if (errors.size)
      throw new AggregateError(
        [...errors.values()],
        'Profile entries failed: ' + [...errors.keys()].join(', '),
      );
    await ctx.parallel('harness/start');
    for (const { id } of profile.nativeEntries) {
      const entry = profile.entries.get(id);
      if (entry?.error) throw new Error('Profile entry failed: ' + id, { cause: entry.error });
    }
    if (name === 'web' && !ctx.get('harnessWeb'))
      throw new Error('The Web Profile requires an available HTTP server');
    await ctx.parallel('harness/open');
    profile.finishMigration();
  } catch (error) {
    await close();
    const issues =
      error instanceof AggregateError ? ': ' + error.errors.map((issue) => String(issue)).join('; ') : '';
    throw new Error(String(error) + issues, { cause: error });
  }
  return { ctx, close };
}
