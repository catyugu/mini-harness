import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync, watch } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getPaths, ensurePaths, writeJson } from '@mini-harness/platform/config';

async function port() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a development port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function terminate(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill();
  try { await closed; } finally { clearTimeout(force); }
}

export async function pluginDev(input: string, executable: string) {
  const folder = realpathSync(resolve(input));
  const id = basename(folder);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !lstatSync(join(folder, 'plugin.json')).isFile())
    throw new Error('Use a plugin directory with a lowercase ID and a plugin.json file');
  const selected = await port();
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mini-harness-dev-'));
  const env = { ...process.env, MINI_HARNESS_HOME: home, MINI_HARNESS_DEV_PLUGIN: folder };
  const paths = getPaths(process.cwd(), env);
  ensurePaths(paths);
  writeJson(paths.settings, { plugins: { [id]: true } });
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let server: ChildProcess | undefined;
  let building = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let update: Promise<void> | undefined;

  async function rebuild() {
    building = true;
    try {
      if (lstatSync(join(folder, 'package.json'), { throwIfNoEntry: false })?.isFile()) {
        const npm = env.MINI_HARNESS_NPM_CLI ?? join(dirname(process.execPath),
          process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
        const build = spawn(process.execPath, [npm, 'run', 'build', '--if-present'], { cwd: folder, stdio: 'inherit', signal: lifetime.signal });
        await new Promise<void>((done, reject) => {
          build.once('error', reject);
          build.once('close', (code) => code === 0 ? done() : reject(new Error('Plugin build failed')));
        });
      }
      lifetime.signal.throwIfAborted();
      await terminate(server);
      lifetime.signal.throwIfAborted();
      server = spawn(process.execPath, [executable, '--no-open', '--port', String(selected)], { env, stdio: 'inherit' });
      server.once('error', (error) => console.error('Could not start plugin host:', error.message));
    } catch (error) {
      if (!lifetime.signal.aborted) console.error('Plugin development:', error instanceof Error ? error.message : String(error));
    } finally { building = false; }
  }

  const watcher = watch(folder, { recursive: true }, (_event, file) => {
    if (building || !file || /(?:^|[/\\])(?:node_modules|\.git)(?:[/\\]|$)/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => { update = rebuild(); }, 200);
  });
  watcher.on('error', (error) => { console.error(error.message); stop(); });
  try {
    console.log('Developing ' + id + ' in an isolated instance at port ' + selected);
    update = rebuild();
    if (!lifetime.signal.aborted)
      await new Promise<void>((done) => lifetime.signal.addEventListener('abort', () => done(), { once: true }));
  } finally {
    clearTimeout(timer);
    watcher.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await update;
    await terminate(server);
    rmSync(home, { recursive: true, force: true });
  }
}
