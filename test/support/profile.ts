import { bootProfile } from '@mini-harness/host/application';
import { initializeProfile, loadProfile } from '@mini-harness/host/profile';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginHost } from '@mini-harness/plugins/manager';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import { Context } from 'mini-harness/cordis';

export async function startTestProfile(
  paths: Paths,
  name: string,
  plugins: { name: string; config?: Record<string, unknown> }[],
) {
  const directory = initializeProfile(name, paths);
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify({ plugins }));
  return bootProfile(name, paths, { interactive: false, shutdown() {} });
}

export async function storedProfile(paths: Paths, name = 'web') {
  const profile = await loadProfile(name, paths, new Context());
  try {
    return profile.read();
  } finally {
    await profile.close();
  }
}

export class MiniHarnessRuntime {
  private profile?: Awaited<ReturnType<typeof bootProfile>>;
  constructor(readonly paths: Paths) {}
  async start() {
    this.profile = await bootProfile('web', this.paths, {
      interactive: false,
      shutdown: () => void this.stop(),
    });
  }
  get plugins() {
    return this.profile!.ctx.harnessPluginCatalog as PluginHost;
  }
  get configuration() {
    return this.profile!.ctx.harnessProfileConfig;
  }
  get settings() {
    return this.configuration.settings;
  }
  stop() {
    return this.profile?.close() ?? Promise.resolve();
  }
}

export async function createMiniHarnessServer(paths: Paths) {
  const runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  const web = runtime.plugins.ctx.harnessWeb;
  return { ...web, runtime, close: () => runtime.stop() };
}
