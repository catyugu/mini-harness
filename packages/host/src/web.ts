import type { Context, Plugin } from 'mini-harness/cordis';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { DomainError } from '@mini-harness/platform/errors';
import { writeJson } from '@mini-harness/platform/json';
import { webServer } from './server.ts';

export const metadata: PluginInfo = {
  title: 'HTTP server',
  description: 'Serve the local Web application.',
  scope: 'application',
};

const plugin: Plugin.Object = {
  inject: [
    'harnessState',
    'harnessLaunch',
    'harnessWebToken',
    'harnessRoutes',
    'harnessUpgrades',
    'harnessPluginCatalog',
    'harnessGateway',
  ],
  provide: ['harnessWeb', 'harnessNetwork'],
  apply(ctx: Context, config: { port?: number }) {
    ctx.on('internal/update', () => {
      throw new DomainError('conflict', 'Changing HTTP server configuration requires a Profile restart');
    });
    const launch = ctx.harnessLaunch;
    const paths = ctx.harnessState.paths;
    let port = config.port ?? 3837;
    let open = !launch.detached;
    const flags = launch.flags ?? [];
    const help = flags.includes('--help') || flags.includes('-h');
    for (let index = 0; !help && index < flags.length; index++) {
      if (flags[index] === '--no-open') open = false;
      else if (flags[index] === '--port') port = Number(flags[++index]);
      else throw new Error('Unknown Web option: ' + flags[index]);
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
    const web = webServer(ctx, ctx.harnessWebToken, launch.shutdown);
    ctx.provide('harnessWeb', web);
    ctx.effect(() => async () => {
      await web.close();
      if (launch.interactive) rmSync(paths.pid, { force: true });
    });
    ctx.on('harness/open', async () => {
      if (!launch.interactive) return;
      if (help) {
        console.log(
          'Web options:\\n  --port <number>  Listen port (default 3837)\\n  --no-open        Do not open a browser',
        );
        launch.shutdown();
        return;
      }
      try {
        const listening = await web.listen(port);
        const url = 'http://127.0.0.1:' + listening;
        const address = url + '/#token=' + web.token;
        writeJson(paths.pid, { pid: process.pid, url, startedAt: new Date().toISOString() });
        console.log('mini-harness listening at ' + (launch.detached ? url : address));
        if (open) {
          const command =
            process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          const child = spawn(
            command,
            process.platform === 'win32' ? ['url.dll,FileProtocolHandler', address] : [address],
            { stdio: 'ignore', detached: true, windowsHide: true },
          );
          child.on('error', () => {});
          child.unref();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
          throw new Error('The requested HTTP port is already in use. Choose another with --port.');
        throw error;
      }
    });
  },
};

export default plugin;

declare module 'mini-harness/cordis' {
  interface Context {
    harnessWeb: ReturnType<typeof webServer>;
  }
}
