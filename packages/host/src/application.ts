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
          await profile.entries.close();
        }
      }
    })());
  try {
    const errors = await profile.entries.update(profile.bootstrap);
    if (errors.size)
      throw new AggregateError(
        [...errors.values()],
        'Profile infrastructure failed: ' + [...errors.keys()].join(', '),
      );
    for (const { id } of profile.bootstrap)
      if (!profile.entries.get(id)?.active)
        throw new Error('Profile infrastructure is waiting for a dependency: ' + id);
    await ctx.parallel('harness/start');
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
